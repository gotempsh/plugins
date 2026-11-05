// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Report } from "./types";
export class Store {
  private db: Database;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new Database(join(directory, "site-crawl.sqlite"), {
      create: true,
    });
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL)",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    for (const row of this.db
      .query<{ payload: string }, []>(
        "SELECT payload FROM reports WHERE state='running'",
      )
      .all()) {
      const report = JSON.parse(row.payload) as Report;
      report.state = "interrupted";
      report.finishedAt = new Date().toISOString();
      report.error =
        "The plugin restarted during this crawl. Start a new crawl to finish checking the site.";
      this.save(report);
    }
  }
  save(report: Report) {
    this.db
      .query(
        "INSERT INTO reports(id,started_at,state,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=excluded.payload",
      )
      .run(report.id, report.startedAt, report.state, JSON.stringify(report));
    this.db.exec(
      "DELETE FROM reports WHERE state != 'running' AND id NOT IN (SELECT id FROM reports ORDER BY started_at DESC LIMIT 30)",
    );
  }
  list() {
    return this.db
      .query<{ payload: string }, []>(
        "SELECT payload FROM reports ORDER BY started_at DESC LIMIT 30",
      )
      .all()
      .map((row) => {
        const report = JSON.parse(row.payload) as Report;
        return {
          ...report,
          pages: undefined,
          checked: report.pages.length,
          errors: report.pages.filter((page) =>
            page.issues.some((issue) => issue.severity === "error"),
          ).length,
          issues: report.pages.reduce(
            (sum, page) => sum + page.issues.length,
            0,
          ),
        };
      });
  }
  get(id: string): Report | null {
    const row = this.db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM reports WHERE id=?",
      )
      .get(id);
    return row ? (JSON.parse(row.payload) as Report) : null;
  }
  delete(id: string) {
    this.db.query("DELETE FROM reports WHERE id=?").run(id);
  }
  metadata<T>(key: string, fallback: T): T {
    const row = this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM metadata WHERE key=?",
      )
      .get(key);
    return row ? (JSON.parse(row.value) as T) : fallback;
  }
  setMetadata(key: string, value: unknown) {
    this.db
      .query(
        "INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  transaction(action: () => void) {
    this.db.transaction(action)();
  }
  close() {
    this.db.close();
  }
}
