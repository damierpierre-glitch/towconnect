// revalidatePath is a Next cache instruction. There is no cache here, so it
// records the call instead — which is itself worth asserting: an action that
// silently stops revalidating leaves a stale dashboard.
export const revalidated: string[] = [];
export function revalidatePath(path: string): void {
  revalidated.push(path);
}
export function revalidateTag(tag: string): void {
  revalidated.push(`tag:${tag}`);
}
