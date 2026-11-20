import assert from 'node:assert/strict'

export const windowsTaskChatRegion = '.ds-chat-composer-dock section[aria-label="任务"]'

/** Read the visible task in its originating conversation with debug-only task pages excluded. */
export function windowsTaskChatLayoutExpression(marker) {
  return `(() => {
    const composer=document.querySelector('.ds-chat-composer-dock');
    const status=document.querySelector(${JSON.stringify(windowsTaskChatRegion)});
    const timeline=document.querySelector('.ds-message-timeline-content');
    if(!composer?.querySelector('textarea')?.getClientRects().length||!status?.getClientRects().length||!timeline)return null;
    const navigation=[...document.querySelectorAll('nav[aria-label="工作区工具"] button')];
    return { surface:'original-chat', originalPrompt:timeline.textContent.includes(${JSON.stringify(marker)}),
      taskListCount:document.querySelectorAll('[aria-label="任务列表"], .ds-task-sidebar, .ds-task-workspace').length,
      taskNavigationCount:navigation.filter(button=>button.textContent.trim()==='任务'||button.getAttribute('aria-label')==='任务').length,
      taskWorkbenchLinks:[...document.querySelectorAll('button')].filter(button=>button.textContent.trim()==='打开任务工作台').length,
      width:status.getBoundingClientRect().width, overflow:status.scrollWidth-status.clientWidth };
  })()`
}

export function validateWindowsTaskChatLayout(layout) {
  assert.equal(layout?.surface, 'original-chat')
  assert.equal(layout.originalPrompt, true)
  for (const count of [layout.taskListCount, layout.taskNavigationCount, layout.taskWorkbenchLinks]) assert.equal(count, 0)
  assert.ok(Number.isFinite(layout.width) && layout.width > 0)
  assert.ok(Number.isFinite(layout.overflow) && layout.overflow <= 1)
  return layout
}

export async function revealWindowsChatTaskArtifact(cdp, label) {
  const list = `${windowsTaskChatRegion} ul[aria-label="成果"]`
  if (!await cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(list)})?.getClientRects().length)`)) {
    const toggle = `${windowsTaskChatRegion} button[aria-expanded="false"]`
    const count = await cdp.wait(`(() => {
      const match=[...document.querySelectorAll(${JSON.stringify(toggle)})].find(button=>/^\\d+ 个成果$/.test(button.textContent.trim()));
      return match?.textContent.trim();
    })()`, 'the visible artifact count in the original chat')
    await cdp.click(toggle, count)
  }
  const button = `${list} button`
  await cdp.wait(`[...document.querySelectorAll(${JSON.stringify(button)})].some(item=>item.getClientRects().length&&item.textContent.trim()===${JSON.stringify(label)})`, 'the verified artifact in the original chat')
  return button
}
