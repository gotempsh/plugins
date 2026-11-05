// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { PluginEvent } from "@temps-sdk/plugin";
import { crawl, type CrawlOptions } from "./crawler";
import { normalize } from "./http";
import { Store } from "./store";
import {
  message,
  type AutomationSettings,
  type DeploymentTrigger,
  type HostEventAccess,
  type Report,
} from "./types";
export const DEFAULT_AUTOMATION: AutomationSettings = {
  enabled: true,
  productionOnly: true,
  maxPages: 100,
  excludedProjects: [],
};
interface Pending {
  key: string;
  url: string;
  trigger: DeploymentTrigger;
  readyAt: number;
  maxPages: number;
}
interface QueueState {
  pending: Pending[];
  seen: string[];
  projects: { id: number; url: string }[];
  lastEventAt: string | null;
  notice: string | null;
}
export interface SchedulerOptions extends CrawlOptions {
  hostAccess?: () => Promise<HostEventAccess>;
  settleMs?: number;
}
export class Scheduler {
  private active: {
    id: string;
    controller: AbortController;
    done: Promise<void>;
  } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dispatching = false;
  private closed = false;
  constructor(
    private store: Store,
    private options: SchedulerOptions = {},
  ) {}
  private queue(): QueueState {
    return this.store.metadata("queue", {
      pending: [],
      seen: [],
      projects: [],
      lastEventAt: null,
      notice: null,
    });
  }
  settings() {
    return this.store.metadata<AutomationSettings>("automation", {
      ...DEFAULT_AUTOMATION,
      excludedProjects: [],
    });
  }
  async access(): Promise<HostEventAccess> {
    try {
      return (
        (await this.options.hostAccess?.()) ?? {
          configured: false,
          reason:
            "Automatic crawling requires the Temps host and Events read permission.",
          setupPath: "/settings/plugins",
        }
      );
    } catch {
      return {
        configured: false,
        reason:
          "Cannot verify Events read permission. Check the plugin connection and permissions.",
        setupPath: "/settings/plugins",
      };
    }
  }
  async status() {
    const queue = this.queue();
    return {
      settings: this.settings(),
      access: await this.access(),
      queued: queue.pending.length,
      activeReportId: this.active?.id ?? null,
      projects: queue.projects,
      lastEventAt: queue.lastEventAt,
      notice: queue.notice,
    };
  }
  update(input: unknown): AutomationSettings {
    if (!input || typeof input !== "object")
      throw new Error("Send automation settings as a JSON object.");
    const body = input as Record<string, unknown>;
    if (
      typeof body.enabled !== "boolean" ||
      typeof body.productionOnly !== "boolean" ||
      typeof body.maxPages !== "number" ||
      !Number.isInteger(body.maxPages) ||
      body.maxPages < 1 ||
      body.maxPages > 500 ||
      !Array.isArray(body.excludedProjects) ||
      body.excludedProjects.length > 200 ||
      body.excludedProjects.some((id) => !Number.isSafeInteger(id) || id <= 0)
    )
      throw new Error(
        "Settings require enabled, productionOnly, a URL limit from 1 to 500, and at most 200 excluded project IDs.",
      );
    const settings: AutomationSettings = {
      enabled: body.enabled,
      productionOnly: body.productionOnly,
      maxPages: body.maxPages,
      excludedProjects: [...new Set(body.excludedProjects)] as number[],
    };
    const queue = this.queue();
    const count = queue.pending.length;
    queue.pending = queue.pending.filter((job) =>
      this.eligible(job.trigger, settings),
    );
    if (queue.pending.length !== count)
      queue.notice = `${count - queue.pending.length} queued crawl(s) removed by the new automation settings.`;
    this.store.transaction(() => {
      this.store.setMetadata("automation", settings);
      this.store.setMetadata("queue", queue);
    });
    this.kick();
    return settings;
  }
  private eligible(trigger: DeploymentTrigger, settings: AutomationSettings) {
    return (
      settings.enabled &&
      !settings.excludedProjects.includes(trigger.projectId) &&
      (!settings.productionOnly ||
        trigger.environmentName.toLowerCase() === "production")
    );
  }
  deployment(event: PluginEvent) {
    if (this.closed || event.event_type !== "deployment.succeeded") return;
    const data = event.data;
    const projectId = event.project_id ?? data.project_id;
    if (
      typeof projectId !== "number" ||
      !Number.isSafeInteger(projectId) ||
      projectId <= 0 ||
      typeof data.environment_id !== "number" ||
      !Number.isSafeInteger(data.environment_id) ||
      data.environment_id <= 0 ||
      typeof data.deployment_id !== "number" ||
      !Number.isSafeInteger(data.deployment_id) ||
      data.deployment_id <= 0 ||
      typeof data.environment_name !== "string" ||
      data.environment_name.length > 100
    )
      return;
    const trigger = {
      projectId,
      environmentId: data.environment_id,
      deploymentId: data.deployment_id,
      environmentName: data.environment_name,
    };
    const queue = this.queue();
    const key = `${projectId}:${trigger.environmentId}:${trigger.deploymentId}`;
    if (queue.seen.includes(key)) return;
    queue.seen.push(key);
    queue.seen = queue.seen.slice(-200);
    queue.lastEventAt = new Date().toISOString();
    let url: string;
    try {
      if (typeof data.url !== "string")
        throw new Error("Deployment has no URL.");
      url = normalize(data.url).href;
    } catch {
      queue.notice =
        "A deployment was received without a supported public HTTP/HTTPS URL. Start a manual crawl using its public domain.";
      this.store.setMetadata("queue", queue);
      return;
    }
    queue.projects = [
      { id: projectId, url },
      ...queue.projects.filter((project) => project.id !== projectId),
    ].slice(0, 200);
    if (this.eligible(trigger, this.settings())) {
      if (queue.pending.length >= 20)
        queue.notice =
          "The 20-deployment crawl queue is full. This deployment was not queued; run a manual crawl after the queue clears.";
      else
        queue.pending.push({
          key,
          url,
          trigger,
          readyAt: Date.now() + (this.options.settleMs ?? 5000),
          maxPages: this.settings().maxPages,
        });
    }
    this.store.setMetadata("queue", queue);
    this.kick();
  }
  private makeReport(
    url: string,
    maxPages: number,
    trigger?: DeploymentTrigger,
  ): Report {
    return {
      id: crypto.randomUUID(),
      url,
      maxPages,
      ...(trigger ? { trigger } : {}),
      state: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      pages: [],
      notices: [],
      discovered: 0,
      limited: false,
      error: null,
    };
  }
  busy() {
    return (
      this.active !== null ||
      this.dispatching ||
      this.queue().pending.length > 0
    );
  }
  manual(url: string, maxPages: number): string {
    if (this.busy())
      throw new Error(
        "A crawl is running or queued. Wait or cancel it before starting a manual crawl.",
      );
    const report = this.makeReport(url, maxPages);
    this.store.save(report);
    this.run(report);
    return report.id;
  }
  private run(report: Report) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20 * 60 * 1000);
    const done = crawl(report, controller.signal, {
      ...this.options,
      save: (value) => this.store.save(value),
    })
      .catch((error) => {
        console.error(
          JSON.stringify({
            level: "error",
            report_id: report.id,
            error: message(error),
          }),
        );
      })
      .finally(() => {
        clearTimeout(timer);
        this.active = null;
        this.kick();
      });
    this.active = { id: report.id, controller, done };
  }
  kick() {
    if (this.closed || this.active || this.dispatching || this.timer) return;
    const queue = this.queue();
    if (!queue.pending.length) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.dispatch().catch((error) =>
          console.error(
            JSON.stringify({
              level: "error",
              operation: "dispatch deployment crawl",
              error: message(error),
            }),
          ),
        );
      },
      Math.max(0, queue.pending[0]!.readyAt - Date.now()),
    );
  }
  private async dispatch() {
    if (this.closed || this.active || this.dispatching) return;
    this.dispatching = true;
    try {
      const access = await this.access();
      if (this.closed) return;
      const queue = this.queue();
      const job = queue.pending[0];
      if (!job) return;
      if (!access.configured) {
        queue.notice =
          "Queued deployment crawls are paused until Events read permission is available.";
        this.store.setMetadata("queue", queue);
        this.timer = setTimeout(() => {
          this.timer = null;
          this.kick();
        }, 30000);
        return;
      }
      queue.pending.shift();
      if (!this.eligible(job.trigger, this.settings())) {
        this.store.setMetadata("queue", queue);
        return;
      }
      const report = this.makeReport(job.url, job.maxPages, job.trigger);
      this.store.transaction(() => {
        this.store.save(report);
        this.store.setMetadata("queue", queue);
      });
      this.run(report);
    } catch (error) {
      // Storage/dispatch failures must not create an immediate retry loop.
      this.timer = setTimeout(() => {
        this.timer = null;
        this.kick();
      }, 30000);
      throw error;
    } finally {
      this.dispatching = false;
      this.kick();
    }
  }
  cancel(id: string) {
    if (this.active?.id !== id) return false;
    this.active.controller.abort();
    return true;
  }
  isActive(id: string) {
    return this.active?.id === id;
  }
  clearQueue() {
    const queue = this.queue();
    queue.pending = [];
    queue.notice = "Queued deployment crawls were cancelled.";
    this.store.setMetadata("queue", queue);
  }
  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.active) {
      this.active.controller.abort();
      await this.active.done;
    }
  }
}
