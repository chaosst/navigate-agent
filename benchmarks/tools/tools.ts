// benchmarks/tools/tools.ts —— 三方（py-maf / py-crewai / ts-navigate）共用的唯一工具实现
//   - calculator  禁止 eval / Function 构造器，用 shunting-yard（RPN）求值；非法输入返回 { ok:false, error }，不抛异常
//   - weather_now 是 mock 固定数据（可比性优先，不真查天气；source 字段固定为 "mock"）
// 无框架依赖，纯函数。被 benchmark-mcp-server.ts（MCP 包装）与 ts-navigate/runner.ts（import 直调）共用。

export interface ToolCallResult {
    ok: boolean
    value?: string | number
    error?: string
}

// calculator —— 四则运算 + 括号，支持整数/小数、一元负号、空白
// 流程：tokenize（逐字符扫描）→ shunting-yard 转 RPN → 求值
// 失败时返回可读 error 文本，agent 应能据此修正表达式后自愈重试

type Tok =
    | { kind: "num"; value: number }
    | { kind: "op"; op: string } // op ∈ { "+" | "-" | "*" | "/" | "u-" }（u- 为一元负号）
    | { kind: "lp" }
    | { kind: "rp" }

/** 运算符优先级：一元负号最高；二元四则中乘除高于加减 */
const PREC: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "u-": 3 }

/** 逐字符扫描成 token 流；返回 Tok[]，出错则返回错误描述字符串 */
function tokenize(expr: string): Tok[] | string {
    const toks: Tok[] = []
    let i = 0
    while (i < expr.length) {
        const ch = expr[i] ?? ""
        if (/\s/.test(ch)) {
            i++
            continue
        }
        // 数字（含小数：12 / 1.5 / .5 / 1.）
        if (/[0-9.]/.test(ch)) {
            const m = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(expr.slice(i))
            if (!m) return `非法数字（位置 ${i}）：单独的 '.'`
            toks.push({ kind: "num", value: Number(m[0]) })
            i += m[0].length
            continue
        }
        // 运算符：'-' 前面不是数字/右括号时视为一元负号（如 "-3"、"3*-2"）
        if ("+-*/".includes(ch)) {
            const prev = toks[toks.length - 1]
            const isUnary = ch === "-" && !(prev && (prev.kind === "num" || prev.kind === "rp"))
            toks.push({ kind: "op", op: isUnary ? "u-" : ch })
            i++
            continue
        }
        if (ch === "(" || ch === ")") {
            toks.push(ch === "(" ? { kind: "lp" } : { kind: "rp" })
            i++
            continue
        }
        return `非法字符 '${ch}'（位置 ${i}）；只允许数字、四则运算符 + - * /、括号与空格`
    }
    return toks
}

/** shunting-yard：中缀 token 流 → RPN token 队列；出错返回错误描述字符串 */
function toRpn(toks: Tok[]): Tok[] | string {
    const out: Tok[] = []
    const ops: Tok[] = []
    for (const t of toks) {
        if (t.kind === "num") {
            out.push(t)
            continue
        }
        if (t.kind === "op") {
            // 出栈条件：栈顶优先级更高；同级时仅左结合运算符出栈（一元负号右结合，保持原顺序）
            while (ops.length > 0) {
                const top = ops[ops.length - 1]
                if (!top || top.kind !== "op") break
                const topPrec = PREC[top.op]
                const curPrec = PREC[t.op]
                const curLeftAssoc = t.op !== "u-"
                if (topPrec > curPrec || (topPrec === curPrec && curLeftAssoc)) out.push(ops.pop()!)
                else break
            }
            ops.push(t)
            continue
        }
        if (t.kind === "lp") {
            ops.push(t)
            continue
        }
        // ")"：弹出直到匹配的 "("，没有则括号不匹配
        let found = false
        while (ops.length > 0) {
            const top = ops.pop()!
            if (top.kind === "lp") {
                found = true
                break
            }
            out.push(top)
        }
        if (!found) return "括号不匹配：存在多余的 ')'"
    }
    while (ops.length > 0) {
        const top = ops.pop()!
        if (top.kind === "lp") return "括号不匹配：缺少 ')'"
        out.push(top)
    }
    return out
}

/** 消除二进制浮点噪音（如 0.1+0.2 → 0.3）；对 |n| ≤ 1e10 的常规结果安全 */
function roundFloat(n: number): number {
    return Math.round(n * 1e10) / 1e10
}

/** 对 RPN 序列求值 */
function evalRpn(rpn: Tok[]): ToolCallResult {
    const stack: number[] = []
    for (const t of rpn) {
        if (t.kind === "num") {
            stack.push(t.value)
            continue
        }
        if (t.kind === "op" && t.op === "u-") {
            if (stack.length < 1) return { ok: false, error: "表达式不合法：一元负号缺少操作数（如 '-*3'）" }
            stack.push(-stack.pop()!)
            continue
        }
        // 二元运算
        if (stack.length < 2) return { ok: false, error: "表达式不合法：运算符缺少操作数（如 '3+*2' 或 '3+'）" }
        if (t.kind !== 'op') {
            continue;
        }
        const b = stack.pop()!
        const a = stack.pop()!
        let v: number
        switch (t.op) {
            case "+":
                v = a + b
                break
            case "-":
                v = a - b
                break
            case "*":
                v = a * b
                break
            case "/":
                if (b === 0) return { ok: false, error: `除零错误：${a} / 0` }
                v = a / b
                break
            default:
                return { ok: false, error: `未知运算符 '${t.op}'` }
        }
        stack.push(v)
    }
    if (stack.length !== 1)
        return { ok: false, error: "表达式不合法：数字与运算符数量不匹配（如 '3 4' 或 '2+'）" }
    return { ok: true, value: roundFloat(stack[0]!) }
}

export function calculator(expression: string): ToolCallResult {
    if (typeof expression !== "string" || expression.trim() === "")
        return { ok: false, error: "表达式为空；请提供如 '3+4*2' 的四则运算式" }
    const toks = tokenize(expression)
    if (typeof toks === "string") return { ok: false, error: toks }
    const rpn = toRpn(toks)
    if (typeof rpn === "string") return { ok: false, error: rpn }
    return evalRpn(rpn)
}

// weather_now —— mock 固定数据：任何城市都返回同一份天气（可比性优先）
// source 固定为 "mock"，报告据此如实说明"未接真实天气服务"
export function weather_now(city: string): ToolCallResult {
    const value = JSON.stringify({ city, temperature: 22, condition: "sunny", source: "mock" })
    return { ok: true, value }
}
