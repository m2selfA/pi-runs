# 痛点：Pi 对话里的长科学计算接续

本文记录为什么要做 pi-runs。设计见 [design.md](design.md)。

## 工作场景

科研迭代不是「提交完就结束」：

```text
1. Pi 写分析脚本
2. 提交集群 / 本机长任务
3. 任务跑很久（分钟到天）
4. Pi 读结果、继续分析
5. 下一轮
```

最容易断的是 **2 → 3 → 4**。人必须自己盯 `squeue` / `bjobs`，作业结束后再把「继续」喂给 Pi。

调度器各不相同，但用户要的是同一件事：

| 环境 | 提交 |
|---|---|
| Slurm | `sbatch` |
| IBM LSF | `bsub` |
| Windows 本机 | PowerShell `Start-Job` |

## 痛点

### 1. `sbatch` 成功 ≠ 计算成功

`sbatch` / `bsub` / `Start-Job` 返回 0 只表示 **已排队或已拉起**。
Agent 若把这次退出码当成「算完了」，会立刻去读还不存在的结果，或误报成功。

真正的成功是后来的终态：`succeeded` 且 exit 0。

### 2. 把提交命令包进本地 waiter 是错的

常见馊主意：

- `sbatch foo.sh && sleep 无限` 包在 Pi 的 bash 工具里；
- 给 **提交进程** 挂 systemd `OnSuccess=`（提交成功 ≠ 作业成功）；
- 在登录节点上同步死等，占着交互会话。

作业属于调度器，不属于提交它的那个本地进程。本地进程一死，等待也就死了；而作业还在队列里。

### 3. JobID 不是产品对象

Slurm / LSF JobID、PowerShell instance id 只是句柄。一次科研迭代还要记住：

- 工作目录、stdout / stderr、终态哨兵文件
- 期望产出（harvest）
- 用哪种方式在终态时被叫醒
- 同一条 Run 被中断后还能 `wait` / `status`，而不是再提交一次

没有本地账本，插件只能活在当前对话的上下文里。

### 4. Agent 自己 `sleep` + `squeue` 既脆又贵，长 `runs_wait` 也没有真正解决生命周期问题

让模型在 bash 里轮询会烧掉上下文和工具配额、超时策略不统一，而且 Pi 一关循环就没了。

即使把循环包装成一个默认等待一小时的 `runs_wait`，只要它仍运行在 Pi tool call 里，就仍然绑在 Pi 生命周期上。真正的默认长任务路径必须是：`runs_submit -> continuation armed -> 当前 turn 结束`，由独立 runwatchd 在后台观察；`runs_wait` 只保留给显式的短同步等待。

### 5. 只做 Slurm 不够

同一套流程会碰到 LSF 中心和 Windows 桌面。LSF、PowerShell 必须是一等公民，不能事后打补丁。

### 6. 回调通道不是调度器

终态通知可以是：

- 共享盘上的 `terminal` 文件 + sidecar 轮询
- systemd **用户** path unit（盯 sentinel，不是盯 sbatch 进程）
- PowerShell 作业事件
- webhook

这些是 wakeup，不是第四种调度器。把它们和 runner 绑死会让 Linux / Windows 无法共用同一套 Run 状态机。

### 7. 登录节点不是计算节点

探测分区 / 队列可以在登录节点做；重计算不能。插件必须生成包装脚本交给调度器，而不是在 tool 进程里直接跑科学代码。

### 8. 单独的 pi-runs 覆盖不了「Pi 在 Windows、数据在集群」

当 Pi 跑在 Windows 桌面、作业必须在 Linux 登录节点上 `sbatch`、数据在集群共享盘时，本机通常没有 `sbatch`，也看不见共享盘上的 terminal；多级 ProxyJump 的长期保活更不属于 Pi 插件生命周期。

因此必须明确三层：`pi-ssh-tools` 负责 Pi 在线时的远端 workspace 操作；`runwatch` 负责 Pi 退出后的 durable Run lifecycle；`pi-runs` 只负责把 Run 与准确 Pi session/branch 绑定。pi-runs 不再假定本机 PATH 能直接看到 scheduler，也不自己嵌 russh。

## 非目标

- 替代 Slurm / LSF。
- 在 Windows 上维护第二份 Host 通讯录。
- 把长任务等待做进 Pi 的 bash 工具循环。
- 给 sbatch 进程挂 `OnSuccess=`。

## 成功标准

1. Agent 用 `runs_submit` 把长任务 durable hand-off 给 runwatch，并立刻结束当前等待链路。
2. Pi 可以完全退出；Run 仍被独立观察，终态不会因 Pi 生命周期丢失。
3. 终态来自结构化 sentinel 或 scheduler truth，而不是提交命令的退出码。
4. completion 能恢复到创建该 Run 的准确 Pi session/branch；branch 已 divergence 时 fail closed 并要求 rebind。
5. 恢复后 Pi 显式激活 `pi-ssh-tools` 的原 remote workspace，检查结果并继续科研分析。
