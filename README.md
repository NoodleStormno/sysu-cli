# sysu-cli

[![CI](https://github.com/NoodleStormno/sysu-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/NoodleStormno/sysu-cli/actions/workflows/ci.yml)
[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

面向**中山大学校园服务（本科教务系统 `jwxt`、在线教学平台 `lms`、图书馆馆藏 OPAC、体育场馆预约 `gym`、大学服务中心 `usc` 与交费大厅 `pay`）**的 Agent-Friendly 命令行工具与 AI Skill。

把常用教务查询封装成稳定命令和结构化 JSON 输出，供人类终端或 Codex、Claude Code、Cursor 等 AI Agent 直接调用。**不收集账号密码**，通过本机浏览器完成统一身份认证后复用会话。

> 本项目由中大学生个人开发维护，非官方工具。问题反馈与功能建议欢迎提交 [Issue](https://github.com/NoodleStormno/sysu-cli/issues)。

---

## 核心特性

- **登录走浏览器，日常查询走轻量 HTTP**：仅 `auth login` 打开浏览器让你亲自完成统一身份认证（企业微信扫码或 NetID + 滑块验证码），会话 Cookie 导出到本机 `~/.sysu-cli/session.json`（权限 `0600`）。之后的 `course`、`grade`、`exam`、`term` 全部使用 Node.js 原生 `fetch` 直连教务 JSON 接口，**单次查询约 200–400ms，无需每次启动浏览器**。
- **Agent 原生设计**：所有命令统一输出 `{ ok, command, data | error }`，错误码与退出码一一对应（`LOGIN_REQUIRED`、`UPSTREAM_CHANGED`、`NETWORK_ERROR` 等），无需解析自然语言报错。
- **配套 Agent Skill**：内置 [`skills/sysu-cli-skill/SKILL.md`](skills/sysu-cli-skill/SKILL.md)，定义命令路由、登录续期流程与隐私边界。
- **内置接口录制器**：`sysu-cli dev capture` 可在真实浏览器里录制 `/jwxt/` 下的 JSON 请求与响应，方便快速扩展新模块。
- **离线契约测试**：通过 `SYSU_BACKEND=mock` 驱动离线 Fixture 测试，无需联网或登录即可跑通全部单测。

---

## 安装与快速开始

环境要求：**Node.js >= 20**，本机已安装 Google Chrome 或 Microsoft Edge（或通过 Playwright 安装 Chromium），并处于校园网或已连接中大 VPN。

### 1. 克隆并安装

```bash
git clone https://github.com/NoodleStormno/sysu-cli.git
cd sysu-cli
npm install
npm link        # 可选：将 sysu-cli 链接到全局 PATH
```

### 2. 安装给 AI Agent（可选）

```bash
npx skills add https://github.com/NoodleStormno/sysu-cli --skill sysu-cli-skill --global
```

### 3. 检查环境与登录

```bash
sysu-cli doctor
sysu-cli auth login
sysu-cli auth status
```

`auth login` 会弹出 Chrome/Edge 打开中大统一身份认证页，扫码或输入 NetID 登录后窗口自动关闭并保存会话。

---

## 命令一览

| 模块 | 命令 | 说明 |
|---|---|---|
| 环境诊断 | `sysu-cli doctor [--offline]` | 检查 Node 版本、Playwright、本地会话文件及 `jwxt.sysu.edu.cn` 连通性 |
| 认证管理 | `sysu-cli auth login [--browser chrome\|edge\|chromium]` | 打开浏览器完成统一身份认证并保存教务会话 |
| | `sysu-cli auth status` | 检查当前保存的教务会话是否有效 |
| | `sysu-cli auth refresh` | 尝试从浏览器 Profile 静默续期会话 |
| | `sysu-cli auth logout` | 清除本机保存的 `session.json` 与浏览器 Profile |
| 学期校历 | `sysu-cli term current [--term YYYY-N]` | 查询当前学年学期（如 `2026-1`）与当前教学周 |
| 个人课表 | `sysu-cli course today [--date YYYY-MM-DD]` | 查询今天或指定日期的课程安排（自动换算教学周与星期） |
| | `sysu-cli course list [--term YYYY-N] [--week N] [--weekday 1..7]` | 查询指定学期、教学周、星期的课表（自动合并连上节次） |
| | `sysu-cli course export-ics [--week N \| --from-week M --to-week N] [--out a.ics]` | 导出 RFC 5545 `.ics` 日历文件（自动匹配第 1–11 节精确起止时间） |
| 成绩与学分 | `sysu-cli grade list [--term YYYY-N]` | 查询学期成绩单、本地计算的学分加权绩点及官方排名汇总 |
| | `sysu-cli grade credits` | 查询毕业学分修读进度（公必/专必/专选/公选）与分数段分布 |
| | `sysu-cli cet list [--level 4\|6]` | 查询四六级笔试总分、听力/阅读/写作分项及准考证号 |
| 考试安排 | `sysu-cli exam weeks [--term YYYY-N]` | 查询学期内设置的考试周（缓补考、10-17周结课考、18-19周期末考） |
| | `sysu-cli exam list [--term YYYY-N] [--type 类别] [--week-id ID]` | 查询具体考试科目、日期、时间、时长与考场地点 |
| 空闲教室 | `sysu-cli classroom campuses` | 查询全校校区列表与代码（南/北/东/珠海/深圳） |
| | `sysu-cli classroom buildings [--campus 校区]` | 查询指定校区下的教学楼列表与楼层数 |
| | `sysu-cli classroom empty --building 教学楼 [--campus 校区] [--date YYYY-MM-DD] [--sections 1-4]` | 查询指定教学楼在目标日期与节次范围内的空闲教室（加 `--all` 返回含占用详情） |
| 教务通知 | `sysu-cli notice list [--category all\|education\|college] [--search 关键词] [--limit 20]` | 查询教务部与院系发布的通知公告（保研、交流、选课等） |
| 毕业审核 | `sysu-cli completion summary` | 查询毕业学分总体完成率与各类别应修/已修/免修学分明细 |
| | `sysu-cli completion courses [--category 代码] [--search 关键词]` | 查询毕业审核课程完成情况清单 |
| 培养方案 | `sysu-cli program view [--category 分组] [--search 关键词]` | 查看个人培养方案基本信息、毕业学分要求及各模块课程表 |
| 全校开课 | `sysu-cli catalog search [--term YYYY-N] [--name 课程] [--teacher 教师] [--campus 校区]` | 检索全校开课课程（教学班号、教师、院系、校区、学分） |
| 学籍预警 | `sysu-cli profile view` | 查看个人学籍信息与 Ⅰ/Ⅱ/Ⅲ 级学业预警状态 |
| 图书检索 | `sysu-cli library search --query 关键词 [--field any\|title\|author\|isbn\|callno] [--lang zh\|en] [--campus 校区]` | **免登录**检索中大图书馆馆藏书目、索书号、可借册数与各校区分布 |
| | `sysu-cli library holdings --doc 书目号 [--lang zh\|en] [--campus 校区] [--available]` | **免登录**查询指定书目的单册借阅状态（`在架上`/应还日期）、具体楼层架位、索书号与条码 |
| 体育场馆 | `sysu-cli gym login [--browser chrome\|edge\|chromium]` | 打开浏览器登录 `gym.sysu.edu.cn` 并保存运动场馆令牌 |
| | `sysu-cli gym venues [--campus 校区] [--search 关键词]` | 查询全校各校区体育场馆与运动项目列表（羽毛球、乒乓球、网球、游泳、健身等） |
| | `sysu-cli gym slots --venue 场馆名或ID [--date YYYY-MM-DD] [--time HH:MM] [--court 场地名] [--available]` | 查询指定场馆在某天（或未来 4 天）各场地、各时段的实时剩余容量与费用 |
| | `sysu-cli gym me` | 查询个人运动时（Credits）、体育钱包余额及当前有效预约/候补订单 |
| | `sysu-cli gym book --venue 场馆名或ID --date YYYY-MM-DD --time HH:MM [--court 场地名] [--waitlist] [--cash]` | **单次按需**预约指定场地与时段（或 `--waitlist` 候补），内置冷却锁严禁高频连发抢场 |
| | `sysu-cli gym cancel --id 预约UUID` | 取消已预约的体育场地或候补记录 |
| 服务中心 | `sysu-cli usc login [--browser chrome\|edge\|chromium]` | 打开浏览器登录大学服务中心（`usc.sysu.edu.cn`）与交费大厅（`pay.sysu.edu.cn`） |
| | `sysu-cli usc services [--search 关键词] [--limit 20]` | 检索 USC 大学服务中心办理事项（如水电费退费、证明办理、户籍、成绩单等） |
| | `sysu-cli usc tasks [--type todo\|done\|complete]` | 查看个人在 USC 的待办事项、已办事项与办结事项 |
| 交费大厅 | `sysu-cli fee unpaid` | 查询中山大学交费大厅（`pay.sysu.edu.cn`）个人待缴费用账单（学费、住宿费、杂费等） |
| 在线教学 | `sysu-cli lms login [--browser chrome\|edge\|chromium]` | 登录中山大学在线教学平台（`lms.sysu.edu.cn` Moodle）并保存 `MoodleSession` 与 `sesskey` |
| | `sysu-cli lms categories` | **免登录**查询在线教学平台课程分类列表（本科生/研究生/培训/BB迁入课程） |
| | `sysu-cli lms search --query 关键词` | **免登录**全站检索公开/SPOC 课程（课程ID、名称、教师、大纲简介） |
| | `sysu-cli lms courses [--status all\|inprogress\|past\|future] [--search 关键词]` | 查询个人已选修的 LMS 课程列表与完成进度百分比 |
| | `sysu-cli lms deadlines [--days 30]` | 汇总近期 LMS 未交作业与测验 DDL 倒计时时间线 |
| | `sysu-cli lms tasks --course 课程ID [--type video\|quiz\|assign\|page\|all] [--todo] [--open] [--limit 5]` | 提取课程下所有任务/活动链接（支持 `--type video` 筛选待看视频课、`--todo` 筛选未完成项、`--open` 批量在浏览器打开） |
| | `sysu-cli lms quiz --id 测验ID或URL [--attempt 作答ID] [--start]` | 获取小测/章节测验题目与选项内容并转为纯文本（`text`）及结构化 JSON |
| 开发工具 | `sysu-cli dev capture [--url URL]` | 打开浏览器录制 `/jwxt/` 下的 JSON 接口，用于分析扩展新模块 |

> **学期参数格式**：`YYYY-N`（其中 `YYYY` 为学年起始年份，例如 `2026-1` 表示 2026–2027 学年第一学期；同样兼容 `2026-2027-1`）。省略 `--term` 时默认查询当前学期。

---

## 输出示例

```bash
$ sysu-cli course today
```

```json
{
  "ok": true,
  "command": "course today",
  "data": {
    "term": "2026-1",
    "termLabel": "2026-2027 学年第一学期",
    "date": "2026-10-23",
    "week": 7,
    "currentWeek": 7,
    "weekday": 5,
    "weekdayName": "周五",
    "count": 2,
    "courses": [
      {
        "term": "2026-1",
        "week": 7,
        "weekday": 5,
        "weekdayName": "周五",
        "date": "2026-10-23",
        "startSection": 1,
        "endSection": 2,
        "sections": "1-2",
        "courseName": "数据结构与算法",
        "teacher": "张老师",
        "location": "东校园公教楼B201",
        "classCode": "202600001"
      }
    ]
  }
}
```

---

## 架构

```text
User / AI Agent
  -> sysu-cli CLI (src/main.js, structured JSON contract)
  -> Domain modules (term / course / grade / exam / auth / doctor / dev)
  -> Pure parsers (src/parsers/*-parser.js)
  -> JwxtClient (src/lib/jwxt.js, Node fetch + CookieJar, ~/.sysu-cli/session.json)
  -> jwxt.sysu.edu.cn
```

完整返回格式与错误码说明见 [docs/cli-contract.md](docs/cli-contract.md)。

---

## 安全与合规边界

- **不碰密码**：CLI 从不读取或保存 NetID 账号密码。
- **不绕过验证**：不绕过统一身份认证、极验（Geetest）滑块、企业微信扫码、访问频率限制或校园网/VPN 限制。
- **只读与低频按需优先**：内置请求节流（`paceRequest`）与跨进程冷却锁（`enforceActionCooldown`），在代码与 Skill 层面双重限制高频轮询、并发爬虫与毫秒级抢场循环。
- **本地隔离**：Cookie 与录制文件仅保存在 `~/.sysu-cli/`，已在 `.gitignore` 中排除，请勿手动提交或分享。

---

## 开发与测试

```bash
npm test
```

## 许可证

[MIT](LICENSE)
