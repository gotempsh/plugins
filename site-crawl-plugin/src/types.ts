// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
export type Severity = "error" | "warning" | "info";
export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  fix: string;
}
export interface Page {
  url: string;
  finalUrl: string;
  status: number | null;
  durationMs: number;
  title: string;
  description: string;
  canonical: string | null;
  sources: string[];
  redirects: string[];
  issues: Issue[];
}
export interface Report {
  id: string;
  trigger?: DeploymentTrigger;
  url: string;
  maxPages: number;
  state: "running" | "completed" | "cancelled" | "failed" | "interrupted";
  startedAt: string;
  finishedAt: string | null;
  pages: Page[];
  notices: string[];
  discovered: number;
  limited: boolean;
  error: string | null;
}
export class CrawlError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "CrawlError";
  }
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected crawl failure";
}
export interface DeploymentTrigger {
  projectId: number;
  environmentId: number;
  environmentName: string;
  deploymentId: number;
}
export interface AutomationSettings {
  enabled: boolean;
  productionOnly: boolean;
  maxPages: number;
  excludedProjects: number[];
}
export interface HostEventAccess {
  configured: boolean;
  reason: string | null;
  setupPath: string;
}
