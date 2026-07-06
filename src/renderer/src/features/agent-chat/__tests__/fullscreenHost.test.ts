import { afterEach, describe, expect, it } from 'vitest';
import { syncAgentHostIntoFullscreen } from '../mount';

/**
 * 浏览器全屏(element fullscreen)只渲染 fullscreenElement 的后代:
 * 导演台「⛶ 全屏」期间 agent 面板必须被搬进全屏元素才可见,
 * 退出后要搬回 body。
 */

function setFullscreenElement(el: Element | null): void {
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => el,
  });
}

afterEach(() => {
  setFullscreenElement(null);
  document.body.innerHTML = '';
});

describe('syncAgentHostIntoFullscreen', () => {
  it('进入全屏:把 host 搬进 fullscreenElement', () => {
    const shell = document.createElement('div');
    document.body.appendChild(shell);
    const host = document.createElement('div');
    document.body.appendChild(host);

    setFullscreenElement(shell);
    syncAgentHostIntoFullscreen(host);
    expect(host.parentElement).toBe(shell);
  });

  it('已在全屏元素内:不重复搬动', () => {
    const shell = document.createElement('div');
    document.body.appendChild(shell);
    const host = document.createElement('div');
    shell.appendChild(host);

    setFullscreenElement(shell);
    syncAgentHostIntoFullscreen(host);
    expect(host.parentElement).toBe(shell);
  });

  it('退出全屏:把 host 搬回 body(含全屏元素已被移除的分支)', () => {
    const shell = document.createElement('div');
    const host = document.createElement('div');
    shell.appendChild(host);
    // shell 未挂在 document 上 = 导演台关闭时全屏元素连带被移除
    setFullscreenElement(null);
    syncAgentHostIntoFullscreen(host);
    expect(host.parentElement).toBe(document.body);
  });

  it('host 为 null 时安全 no-op', () => {
    expect(() => syncAgentHostIntoFullscreen(null)).not.toThrow();
  });
});
