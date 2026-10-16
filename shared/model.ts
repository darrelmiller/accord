export interface WorkspaceInfo {
  id: string;
  root: string;
  documents: string[];
}

export interface TextEdit {
  id: string;
  text: string;
}

export interface Heading {
  id: string;
  level: number;
  text: string;
}

export interface DocumentView {
  path: string;
  title: string;
  version: string;
  editable: boolean;
  warnings: string[];
  html: string;
  headings: Heading[];
  text: Record<string, string>;
  reviewRecords: number;
}

export interface SaveRequest {
  path: string;
  version: string;
  edits: TextEdit[];
}
