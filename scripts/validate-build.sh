#!/usr/bin/env bash
set -euo pipefail

image='oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895'
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=128 --memory=512m --cpus=1 --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --mount type=bind,src="$PWD",dst=/work,readonly --workdir /work \
  "$image" bun scripts/catalog.ts --plan > "$scratch/plan.json"

jq -c '.[]' "$scratch/plan.json" | while IFS= read -r item; do
  repo="$(jq -r '.repository | sub("^https://github.com/"; "")' <<< "$item")"
  commit="$(jq -r '.commit' <<< "$item")"
  project="$scratch/project"
  mkdir -p "$project"
  curl --fail --location --silent --show-error --max-time 60 \
    --max-filesize 20971520 "https://api.github.com/repos/$repo/tarball/$commit" -o "$scratch/source.tar.gz"
  if (( $(wc -c < "$scratch/source.tar.gz") > 20971520 )); then
    echo 'Archive exceeds 20 MiB compressed limit' >&2
    exit 1
  fi
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp --cap-drop=ALL --security-opt=no-new-privileges \
    --pids-limit=128 --memory=512m --cpus=1 --tmpfs /tmp:rw,nosuid,nodev,size=128m \
    --mount type=bind,src="$project",dst=/work --mount type=bind,src="$scratch/source.tar.gz",dst=/source.tar.gz,readonly \
    --mount type=bind,src="$PWD/scripts",dst=/scripts,readonly \
    --workdir /work "$image" bun /scripts/safe-extract.ts /source.tar.gz /work
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp --cap-drop=ALL --security-opt=no-new-privileges \
    --pids-limit=128 --memory=2g --cpus=2 --tmpfs /tmp:rw,nosuid,nodev,size=512m \
    --mount type=bind,src="$project",dst=/work --workdir /work "$image" bun install --frozen-lockfile --ignore-scripts
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp --network=none --cap-drop=ALL --security-opt=no-new-privileges \
    --pids-limit=128 --memory=2g --cpus=2 --tmpfs /tmp:rw,nosuid,nodev,size=512m \
    --mount type=bind,src="$project",dst=/work --workdir /work "$image" sh -c '
      entrypoint="$(bun -e "const p=await Bun.file(\"package.json\").json();const e=p.temps?.entrypoint;if(typeof e!==\"string\"||!/^src\\/[a-zA-Z0-9_./-]+\\.tsx?$/.test(e)||e.includes(\"..\"))process.exit(1);console.log(e)")"
      bun build "$entrypoint" --target=bun --compile --outfile /tmp/temps-plugin-check
    '
  echo "Build checked $repo@$commit (install scripts disabled; compile network disabled)"
  rm -rf "$project" "$scratch/source.tar.gz"
done
cp "$scratch/plan.json" .catalog-build-plan.json
