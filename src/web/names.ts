import type { SceneNode } from "../shared/vibes.ts";

export const shaderName = (node: SceneNode) => node.meta?.name ?? `Shader #${node.id}`;
