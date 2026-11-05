// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { TempsClient } from "@temps-sdk/plugin";
import type { HostEventAccess } from "./types";
/** beta.1 exposes generic protocol calls; newer host discovery is validated at this boundary. */
export async function eventAccess(
  client: TempsClient,
): Promise<HostEventAccess> {
  const call = client.call.bind(client) as (
    method: string,
    params: Record<string, never>,
  ) => Promise<unknown>;
  const result = await call("get_host_capabilities", {});
  if (
    !result ||
    typeof result !== "object" ||
    !("permissions" in result) ||
    !Array.isArray(result.permissions)
  )
    throw new Error("Host does not expose plugin permission discovery.");
  const configured = result.permissions.includes("events_read");
  return {
    configured,
    reason: configured
      ? null
      : "Grant Events read to Site Crawl in Settings → Plugins → Permissions to receive deployment events.",
    setupPath: "/settings/plugins",
  };
}
