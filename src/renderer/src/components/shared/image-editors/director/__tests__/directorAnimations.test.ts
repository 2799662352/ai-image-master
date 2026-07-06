import { describe, it, expect } from 'vitest';
import { animUrl, filterAnimations, type DirectorAnimation } from '../directorAnimations';

const A = (p: Partial<DirectorAnimation>): DirectorAnimation => ({
  id: '1',
  cat: 'C',
  name: '走路',
  nameEn: 'Walking',
  uid: 'a'.repeat(32),
  ...p,
});

describe('animUrl', () => {
  it('无自有桶 → 拼原始 CDN(默认 animation.fbx)', () => {
    expect(animUrl(A({}), '')).toBe(
      `https://rh-canvas-files.xiaoyaoyou.com/default/animation/${'a'.repeat(32)}/animation.fbx`,
    );
  });

  it('保留非默认文件名', () => {
    expect(animUrl(A({ file: 'Funky_Pocoto' }), '')).toContain('/Funky_Pocoto.fbx');
  });

  it('自有桶 base → <base>/animations/<id>.fbx(容忍尾斜杠)', () => {
    expect(animUrl(A({ id: '42' }), 'https://cdn.me/dir/')).toBe(
      'https://cdn.me/dir/animations/42.fbx',
    );
  });
});

describe('filterAnimations', () => {
  const list = [
    A({ id: '1', cat: 'WALK', name: '走路', nameEn: 'Walking' }),
    A({ id: '2', cat: 'WALK', name: '跑步', nameEn: 'Running fast' }),
    A({ id: '3', cat: 'DANCE', name: '街舞', nameEn: 'Hip Hop Dance' }),
  ];

  it('默认返回全部', () => {
    expect(filterAnimations(list)).toHaveLength(3);
  });

  it('按分类过滤', () => {
    expect(filterAnimations(list, { category: 'WALK' })).toHaveLength(2);
  });

  it('中文关键词', () => {
    const hit = filterAnimations(list, { keyword: '街舞' });
    expect(hit).toHaveLength(1);
    expect(hit[0].id).toBe('3');
  });

  it('英文关键词不分大小写', () => {
    const hit = filterAnimations(list, { keyword: 'runNING' });
    expect(hit).toHaveLength(1);
    expect(hit[0].id).toBe('2');
  });

  it('分类+关键词组合', () => {
    expect(filterAnimations(list, { category: 'WALK', keyword: 'dance' })).toHaveLength(0);
  });
});
