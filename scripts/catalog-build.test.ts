import { expect, test } from "bun:test";

for (const path of ["../.github/workflows/catalog.yml", "./validate-build.sh"]) {
  test(`${path}: catalog containers use the bind-mount owner's identity`, async () => {
    const source = await Bun.file(new URL(path, import.meta.url)).text();
    const commands = source.split("\n").filter(line => line.includes("docker run --rm"));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toContain('--user "$(id -u):$(id -g)"');
      expect(command).toContain('-e HOME=/tmp');
      expect(command).toContain('--cap-drop=ALL');
      expect(command).toContain('--security-opt=no-new-privileges');
    }
    expect(source).toContain('--network=none');
    expect(source).toContain('--ignore-scripts');
  });
}
