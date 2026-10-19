// Boxes as pods on the cluster vibes runs in (kokuzo's k3s): each a pod in
// its own namespace, run in a Kata VM (BOX_RUNTIME_CLASS; none on a local
// cluster), reached at the pod's address, with everyone's homes (BOX_HOMES, a
// directory on the machine) at /homes, for its agent to take the one it's
// claimed for from. vibes talks to the cluster's API as its own service
// account, which may only manage pods there (.kube/boxes.yaml).

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import type { BoxRunner } from "./boxes.ts";
import type { SketchesConfig } from "./env.ts";

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
// A pod that isn't running by then (a first boot pulls the image) has failed.
const RUNNING_TIMEOUT_MS = 5 * 60_000;

interface Pod {
  spec: { containers: { image: string }[] };
  status: { phase?: string; podIP?: string };
  metadata: { name: string; deletionTimestamp?: string };
}

export function kubernetesRunner(sketches: SketchesConfig): BoxRunner {
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
                // Its agent starts as root, in the VM, with just what it needs to
                // move a home in and start VS Code as its person (who has none).
                securityContext: {
                  runAsUser: 0,
                  runAsGroup: 0,
                  capabilities: { drop: ["ALL"], add: ["SYS_ADMIN", "CHOWN", "SETUID", "SETGID", "KILL"] },
                },
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

    // A pod of its own, which only removes them: the homes are on the machine,
    // where vibes can't reach.
    async removeHomes(ids) {
      const name = `homes-gone-${randomBytes(4).toString("hex")}`;
      await check(
        "making the pod that erases homes",
        kube("POST", pods, {
          metadata: { name, labels: { app: "vibes-homes-gone" } },
          spec: {
            ...(sketches.runtimeClass ? { runtimeClassName: sketches.runtimeClass } : {}),
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            restartPolicy: "Never",
            containers: [
              {
                name: "rm",
                image: sketches.image,
                imagePullPolicy: "IfNotPresent",
                command: ["rm", "-rf", ...ids.map((id) => `/homes/${id}`)],
                // Root, able to remove what's the person's (uid 1000).
                securityContext: { runAsUser: 0, runAsGroup: 0, capabilities: { drop: ["ALL"], add: ["DAC_OVERRIDE"] } },
                volumeMounts: [{ name: "homes", mountPath: "/homes" }],
              },
            ],
            volumes: [{ name: "homes", hostPath: { path: sketches.homes, type: "DirectoryOrCreate" } }],
          },
        }),
      );
      try {
        const deadline = Date.now() + RUNNING_TIMEOUT_MS;
        for (;;) {
          const phase = (await getPod(name))?.status.phase;
          if (phase === "Succeeded") return;
          if (phase === "Failed") throw new Error("erasing the homes failed");
          if (Date.now() > deadline) throw new Error("erasing the homes didn't finish in time");
          await new Promise((r) => setTimeout(r, 1000));
        }
      } finally {
        await kube("DELETE", `${pods}/${name}`);
      }
    },

    async list(image) {
      const res = await check("listing boxes", kube<{ items: Pod[] }>("GET", `${pods}?labelSelector=${encodeURIComponent("app=vibes-box")}`));
      return res.data.items
        .filter((p) => !p.metadata.deletionTimestamp)
        .map((p) => ({ name: p.metadata.name, current: p.spec.containers[0]?.image === image }));
    },
  };
}
