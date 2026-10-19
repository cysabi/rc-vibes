// Boxes as pods on the cluster vibes runs in (kokuzo's k3s): each a pod in
// its own namespace, run in a Kata VM (BOX_RUNTIME_CLASS; none on a local
// cluster), reached at the pod's address, with everyone's homes (BOX_HOMES, a
// directory on the machine) at /homes, for its agent to take the one it's
// claimed for from. vibes talks to the cluster's API as its own service
// account, which may only manage pods there (.kube/boxes.yaml).

import { readFileSync } from "node:fs";
import https from "node:https";
import { BOX_CAPABILITIES, type BoxRunner } from "./boxes.ts";
import { BUILD_CAPABILITIES, type BuildRunner } from "./builds.ts";
import type { SketchesConfig } from "./env.ts";

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
// A pod that isn't running by then (a first boot pulls the image) has failed.
const RUNNING_TIMEOUT_MS = 5 * 60_000;

interface Pod {
  spec: { containers: { image: string }[] };
  status: { phase?: string; podIP?: string };
  metadata: { name: string; deletionTimestamp?: string };
}

export function kubernetesRunner(sketches: SketchesConfig): BoxRunner & BuildRunner {
  const ns = sketches.namespace;
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
  if (!host) throw new Error("BOX_RUNNER=kubernetes, but this isn't running in a cluster (no KUBERNETES_SERVICE_HOST)");
  const ca = readFileSync(`${SA}/ca.crt`);
  // The token is rotated now and then: read it fresh each time.
  const token = () => readFileSync(`${SA}/token`, "utf8").trim();

  function kube<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request(
        {
          host,
          port,
          method,
          path,
          ca,
          headers: {
            authorization: `Bearer ${token()}`,
            accept: "application/json",
            ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString();
            let data: unknown = null;
            try {
              data = text ? JSON.parse(text) : null;
            } catch {
              data = text;
            }
            resolve({ status: res.statusCode ?? 0, data: data as T });
          });
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  }

  const pods = `/api/v1/namespaces/${ns}/pods`;

  async function check<T>(what: string, call: Promise<{ status: number; data: T }>, ok: number[] = [200, 201]) {
    const res = await call;
    if (!ok.includes(res.status)) throw new Error(`${what}: Kubernetes answered ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
    return res;
  }

  const getPod = async (name: string) => {
    const res = await kube<Pod>("GET", `${pods}/${name}`);
    return res.status === 200 ? res.data : null;
  };

  const targetOf = (pod: Pod | null) =>
    pod && !pod.metadata.deletionTimestamp && pod.status.phase === "Running" && pod.status.podIP ? `http://${pod.status.podIP}:3000` : null;

  return {
    find: async (name) => targetOf(await getPod(name)),

    async boot(name, image, env) {
      await check(
        "making the box",
        kube("POST", pods, {
          metadata: { name, labels: { app: "vibes-box" } },
          spec: {
            ...(sketches.runtimeClass ? { runtimeClassName: sketches.runtimeClass } : {}),
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            // Never started again: one that ends is removed, and another booted.
            restartPolicy: "Never",
            containers: [
              {
                name: "box",
                image,
                imagePullPolicy: "IfNotPresent",
                env: Object.entries(env).map(([k, v]) => ({ name: k, value: v })),
                ports: [{ containerPort: 3000 }],
                resources: { requests: { cpu: "100m", memory: "512Mi" }, limits: { cpu: "2", memory: "2Gi" } },
                // Its agent starts as root, in the VM, with just what it needs
                // (BOX_CAPABILITIES); the person has none.
                securityContext: { runAsUser: 0, runAsGroup: 0, capabilities: { drop: ["ALL"], add: BOX_CAPABILITIES } },
                volumeMounts: [{ name: "homes", mountPath: "/homes" }],
              },
            ],
            volumes: [{ name: "homes", hostPath: { path: sketches.homes, type: "DirectoryOrCreate" } }],
          },
        }),
      );
      const deadline = Date.now() + RUNNING_TIMEOUT_MS;
      for (;;) {
        const pod = await getPod(name);
        const target = targetOf(pod);
        if (target) return target;
        if (pod?.status.phase === "Failed" || pod?.status.phase === "Succeeded") throw new Error("its pod ended as it started");
        if (Date.now() > deadline) throw new Error("its pod didn't start running in time");
        await new Promise((r) => setTimeout(r, 500));
      }
    },

    async remove(name) {
      await check("removing the box", kube("DELETE", `${pods}/${name}`), [200, 202, 404]);
    },

    // Builds: a pod each, starting as root with just enough to start Nix's
    // daemon (BUILD_CAPABILITIES), then building as uid 1000; gone by itself
    // after 15 minutes at most.
    async startBuild(name, image, command, env) {
      await check(
        "starting the build",
        kube("POST", pods, {
          metadata: { name, labels: { app: "vibes-build" } },
          spec: {
            ...(sketches.runtimeClass ? { runtimeClassName: sketches.runtimeClass } : {}),
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            restartPolicy: "Never",
            activeDeadlineSeconds: 900,
            containers: [
              {
                name: "build",
                image,
                imagePullPolicy: "IfNotPresent",
                command,
                env: Object.entries(env).map(([k, v]) => ({ name: k, value: v })),
                resources: { requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: "2", memory: "2Gi" } },
                securityContext: { runAsUser: 0, runAsGroup: 0, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"], add: BUILD_CAPABILITIES } },
              },
            ],
          },
        }),
      );
    },

    async buildState(name) {
      const pod = await getPod(name);
      if (!pod || pod.metadata.deletionTimestamp) return "gone";
      return pod.status.phase === "Succeeded" || pod.status.phase === "Failed" ? "ended" : "running";
    },

    async removeBuild(name) {
      await check("removing the build", kube("DELETE", `${pods}/${name}`), [200, 202, 404]);
    },

    async builds() {
      const res = await check("listing builds", kube<{ items: Pod[] }>("GET", `${pods}?labelSelector=${encodeURIComponent("app=vibes-build")}`));
      return res.data.items.map((p) => p.metadata.name);
    },

    async list(image) {
      const res = await check("listing boxes", kube<{ items: Pod[] }>("GET", `${pods}?labelSelector=${encodeURIComponent("app=vibes-box")}`));
      return res.data.items
        .filter((p) => !p.metadata.deletionTimestamp)
        .map((p) => ({ name: p.metadata.name, current: p.spec.containers[0]?.image === image }));
    },
  };
}
