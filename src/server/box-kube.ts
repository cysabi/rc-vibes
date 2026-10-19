// Boxes as pods on the cluster vibes runs in (kokuzo's k3s): each a pod
// box-<id> in its own namespace, run in a Kata VM (BOX_RUNTIME_CLASS; none on
// a local cluster), with a volume box-<id> for
// its files, reached at the pod's address. vibes talks to the cluster's API
// as its own service account, which may only manage pods and volumes there
// (.kube/boxes.yaml).

import { readFileSync } from "node:fs";
import https from "node:https";
import type { BoxRunner } from "./boxes.ts";
import type { SketchesConfig } from "./env.ts";

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
// A pod that isn't running by then (a first start pulls the image) has failed.
const RUNNING_TIMEOUT_MS = 5 * 60_000;

interface Pod {
  spec: { containers: { image: string }[] };
  status: { phase?: string; podIP?: string; containerStatuses?: { ready: boolean }[] };
  metadata: { labels?: Record<string, string>; deletionTimestamp?: string };
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
  const claims = `/api/v1/namespaces/${ns}/persistentvolumeclaims`;
  const name = (id: string) => `box-${id}`;

  async function check<T>(what: string, call: Promise<{ status: number; data: T }>, ok: number[] = [200, 201]) {
    const res = await call;
    if (!ok.includes(res.status)) throw new Error(`${what}: Kubernetes answered ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
    return res;
  }

  const getPod = async (id: string) => {
    const res = await kube<Pod>("GET", `${pods}/${name(id)}`);
    return res.status === 200 ? res.data : null;
  };

  const targetOf = (pod: Pod | null) =>
    pod && !pod.metadata.deletionTimestamp && pod.status.phase === "Running" && pod.status.podIP ? `http://${pod.status.podIP}:3000` : null;

  async function gone(id: string) {
    for (let i = 0; i < 120 && (await getPod(id)); i++) await new Promise((r) => setTimeout(r, 1000));
  }

  return {
    find: async (id) => targetOf(await getPod(id)),

    async start(id, image, env) {
      // Its files: made the first time, and kept.
      const claim = await kube("GET", `${claims}/${name(id)}`);
      if (claim.status === 404) {
        await check(
          "making the box's volume",
          kube("POST", claims, {
            metadata: { name: name(id), labels: { app: "vibes-box", "vibes.box": id } },
            spec: { accessModes: ["ReadWriteOnce"], storageClassName: "local-path", resources: { requests: { storage: "5Gi" } } },
          }),
        );
      }
      let pod = await getPod(id);
      // One from an older image, or one that's ended, goes, and a new one is made.
      if (pod && (pod.spec.containers[0]?.image !== image || pod.status.phase === "Failed" || pod.status.phase === "Succeeded" || pod.metadata.deletionTimestamp)) {
        await kube("DELETE", `${pods}/${name(id)}`);
        await gone(id);
        pod = null;
      }
      if (!pod) {
        await check(
          "making the box",
          kube("POST", pods, {
            metadata: { name: name(id), labels: { app: "vibes-box", "vibes.box": id } },
            spec: {
              ...(sketches.runtimeClass ? { runtimeClassName: sketches.runtimeClass } : {}),
              automountServiceAccountToken: false,
              enableServiceLinks: false,
              restartPolicy: "Always",
              securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
              containers: [
                {
                  name: "box",
                  image,
                  imagePullPolicy: "IfNotPresent",
                  env: Object.entries(env).map(([k, v]) => ({ name: k, value: v })),
                  ports: [{ containerPort: 3000 }],
                  resources: { requests: { cpu: "100m", memory: "512Mi" }, limits: { cpu: "2", memory: "2Gi" } },
                  volumeMounts: [{ name: "home", mountPath: "/home/workspace" }],
                },
              ],
              volumes: [{ name: "home", persistentVolumeClaim: { claimName: name(id) } }],
            },
          }),
        );
      }
      const deadline = Date.now() + RUNNING_TIMEOUT_MS;
      for (;;) {
        const target = targetOf(await getPod(id));
        if (target) return target;
        if (Date.now() > deadline) throw new Error("its pod didn't start running in time");
        await new Promise((r) => setTimeout(r, 1000));
      }
    },

    async stop(id) {
      await check("stopping the box", kube("DELETE", `${pods}/${name(id)}`), [200, 202, 404]);
    },

    async running() {
      const res = await check("listing boxes", kube<{ items: Pod[] }>("GET", `${pods}?labelSelector=${encodeURIComponent("app=vibes-box")}`));
      return res.data.items.filter((p) => targetOf(p)).map((p) => p.metadata.labels?.["vibes.box"] ?? "").filter(Boolean);
    },
  };
}
