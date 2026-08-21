import React from "react";
import { Box, Text } from "ink";
import { ControlledTextInput } from "./text-input.js";

interface InputProps {
  onSubmit: (value: string) => void;
  disabled: boolean;
  agentMode?: string;
  onToggleAgentMode?: () => void;
}

export function Input({ onSubmit, disabled, agentMode, onToggleAgentMode }: InputProps) {
  const color = agentMode === 'plan' ? "magenta" : agentMode === 'ptc' ? "magenta" : "cyan"
  const placeholder = agentMode === 'plan' ? "Plan mode — Shift+Tab to toggle..." : agentMode === 'ptc' ? "PTC mode — Shift+Tab to toggle..." : "Type your message..."
  return (
    <Box borderStyle="round" borderColor={color} paddingX={1}>
      <Text bold color={color}>
        {agentMode === 'plan' ? "[Plan] " : agentMode === 'ptc' ? "[PTC] " : "> "}
      </Text>
      <ControlledTextInput
        onSubmit={onSubmit}
        disabled={disabled}
        placeholder={placeholder}
        agentMode={agentMode}
        onToggleAgentMode={onToggleAgentMode}
      />
    </Box>
  );
}
