import React, { useReducer, useRef } from "react";
import { Box, Text, useInput } from "ink";
import type { HumanRequest, HumanResponse } from "../tools/human-channel.js";
import {
  approvalHint,
  formatApproval,
  formatQuestion,
  optionIndexToValue,
  resolveApprovalKey,
} from "./approval-view.js";

interface ApprovalPromptProps {
  request: HumanRequest;
  onAnswer: (res: HumanResponse) => void;
}

/**
 * 审批 / 提问卡片：接管 stdin 并把按键翻译成 HumanResponse。
 *
 * 与输入框的互斥：App 传 disabled={running || !!pending} 给 <Input>，
 * 而 ControlledTextInput 在 disabled 时 effect 直接 return（不注册 stdin handler），
 * 所以任一时刻只有一个 stdin 处理器，按键不会被双消费。
 * 组件按 request.id 作 key 渲染 → 每个请求重新挂载，内部缓冲自然重置。
 */
export function ApprovalPrompt({ request, onAnswer }: ApprovalPromptProps) {
  const [, forceRender] = useReducer((x: number) => x + 1, 0);
  const bufferRef = useRef("");
  const answeredRef = useRef(false);

  useInput((input, key) => {
    if (answeredRef.current) return;

    const submit = (res: HumanResponse): void => {
      answeredRef.current = true;
      onAnswer(res);
    };

    // Esc：审批=拒绝 / 提问=空答案（用户想跳过）
    if (key.escape) {
      submit(
        request.kind === "approval"
          ? { kind: "approval", decision: "deny" }
          : { kind: "question", answer: "" },
      );
      return;
    }

    // 退格：从理由/答案缓冲里删一个字符
    if (key.backspace || key.delete) {
      if (bufferRef.current.length > 0) {
        bufferRef.current = bufferRef.current.slice(0, -1);
        forceRender();
      }
      return;
    }

    // 回车：审批=带（可空）理由拒绝 / 提问=提交答案
    if (key.return) {
      const value = bufferRef.current.trim();
      submit(
        request.kind === "approval"
          ? { kind: "approval", decision: "deny", reason: value.length > 0 ? value : undefined }
          : { kind: "question", answer: value },
      );
      return;
    }

    if (!input || key.ctrl || key.meta) return;

    // 审批：缓冲为空时的 y/a/n 才当决定键；已有文字则继续当理由输入
    if (request.kind === "approval" && bufferRef.current.length === 0) {
      const decision = resolveApprovalKey({ ch: input });
      if (decision) {
        submit({ kind: "approval", decision });
        return;
      }
    }

    // 提问：缓冲为空时的数字才当快选
    if (request.kind === "question" && bufferRef.current.length === 0) {
      const picked = optionIndexToValue(input, request.options);
      if (picked !== null) {
        submit({ kind: "question", answer: picked });
        return;
      }
    }

    bufferRef.current += input;
    forceRender();
  });

  const buffer = bufferRef.current;

  if (request.kind === "approval") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
        <Text color="yellow">{formatApproval(request.tool, request.args, request.permission)}</Text>
        <Text color="yellow">{approvalHint()}</Text>
        <Text dimColor>
          {buffer.length > 0
            ? `拒绝理由：${buffer}（回车提交，Esc 直接拒绝）`
            : "直接回车 = 纯拒绝；输入文字 = 附理由拒绝"}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
      <Text color="cyan">{formatQuestion(request.question, request.options)}</Text>
      <Text dimColor>{buffer.length > 0 ? `回答：${buffer}（回车提交）` : "等待你的回答…（Esc 跳过）"}</Text>
    </Box>
  );
}
