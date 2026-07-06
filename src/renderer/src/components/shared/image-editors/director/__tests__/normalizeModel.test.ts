/**
 * normalizeModel 回归测试 —— 大模型缩放/落地顺序 bug。
 *
 * 旧实现先按未缩放包围盒计算平移(落地+居中),再缩放;缩放围绕对象原点收缩,
 * 导致 >6 单位的大模型缩完后悬浮/下沉/偏心(门底悬空缝、墙体偏出取景框)。
 * 新实现先缩放、重算包围盒、再落地居中。
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { normalizeModel } from '../DirectorStageScene';

/** 一个 size 尺寸、几何中心在 world `center` 的盒子(pivot 在网格原点=组原点). */
function boxAt(center: THREE.Vector3, size: THREE.Vector3): THREE.Object3D {
  const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  mesh.position.copy(center);
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

function worldBox(obj: THREE.Object3D): THREE.Box3 {
  obj.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(obj);
}

describe('normalizeModel', () => {
  it('小模型:水平居中 + 落地,不缩放', () => {
    const obj = boxAt(new THREE.Vector3(3, 5, -2), new THREE.Vector3(1, 2, 1));
    normalizeModel(obj);
    const box = worldBox(obj);
    const center = box.getCenter(new THREE.Vector3());
    expect(center.x).toBeCloseTo(0, 5);
    expect(center.z).toBeCloseTo(0, 5);
    expect(box.min.y).toBeCloseTo(0, 5);
    expect(obj.scale.x).toBeCloseTo(1, 5);
  });

  it('大模型(pivot 偏离几何中心):缩放到 maxDim=4 且仍精确落地居中', () => {
    // 20 单位宽的"公寓",几何中心离 pivot 很远 —— 旧实现在这种模型上
    // 落地误差 = (1-k)*offset,会悬浮 ~9.6 单位。
    const obj = boxAt(new THREE.Vector3(10, 12, -8), new THREE.Vector3(20, 8, 16));
    normalizeModel(obj);
    const box = worldBox(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    expect(Math.max(size.x, size.y, size.z)).toBeCloseTo(4, 5);
    expect(center.x).toBeCloseTo(0, 5);
    expect(center.z).toBeCloseTo(0, 5);
    expect(box.min.y).toBeCloseTo(0, 5); // 不悬浮、不下沉
  });

  it('已有非 1 缩放的模型同样精确落地', () => {
    const obj = boxAt(new THREE.Vector3(0, 50, 0), new THREE.Vector3(100, 100, 100));
    obj.scale.setScalar(0.5); // 有效 maxDim = 50 > 6 → 触发再缩放
    normalizeModel(obj);
    const box = worldBox(obj);
    const size = box.getSize(new THREE.Vector3());
    expect(Math.max(size.x, size.y, size.z)).toBeCloseTo(4, 5);
    expect(box.min.y).toBeCloseTo(0, 5);
  });
});
