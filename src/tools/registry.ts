import { StructuredTool } from "@langchain/core/tools";
import { ShellTool } from "./shell.js";
import { ReadFileTool, WriteFileTool, EditFileTool } from "./filesystem.js";
import { ListFilesTool, SearchFilesTool } from "./search.js";

export function createTools(): StructuredTool[] {
  return [
    new ShellTool(),
    new ReadFileTool(),
    new WriteFileTool(),
    new EditFileTool(),
    new ListFilesTool(),
    new SearchFilesTool(),
  ];
}
