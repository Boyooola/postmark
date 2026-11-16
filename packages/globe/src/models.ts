import { Box3, Group, Mesh, MeshStandardMaterial, Object3D, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const loader = new GLTFLoader();
const cache = new Map<string, Promise<Group | null>>();

/** Load a glTF scene once; later calls share the same template. Resolves null on failure. */
export function loadTemplate(url: string): Promise<Group | null> {
  let p = cache.get(url);
  if (!p) {
    p = loader
      .loadAsync(url)
      .then((g) => g.scene)
      .catch((err) => {
        console.warn("[models] could not load", url, err);
        return null;
      });
    cache.set(url, p);
  }
  return p;
}

/** Size of an object's bounding box (in its parent's space). */
export function sizeOf(o: Object3D): Vector3 {
  o.updateMatrixWorld(true);
  return new Box3().setFromObject(o).getSize(new Vector3());
}

/** Deep-clone a template, giving it its own copies of the named materials (for recolouring). */
export function cloneWithMaterials(template: Object3D, ownMaterials: string[] = []): Object3D {
  const copy = template.clone(true);
  const copies = new Map<string, MeshStandardMaterial>();
  copy.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const next = mats.map((mat) => {
      if (!ownMaterials.includes(mat.name)) return mat;
      let c = copies.get(mat.name);
      if (!c) {
        c = (mat as MeshStandardMaterial).clone();
        copies.set(mat.name, c);
      }
      return c;
    });
    m.material = Array.isArray(m.material) ? next : next[0];
  });
  return copy;
}

/** Find a material by name inside an object. */
export function findMaterial(o: Object3D, name: string): MeshStandardMaterial | null {
  let found: MeshStandardMaterial | null = null;
  o.traverse((c) => {
    const m = c as Mesh;
    if (found || !m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) if (mat.name === name) found = mat as MeshStandardMaterial;
  });
  return found;
}
