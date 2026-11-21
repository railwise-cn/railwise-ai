import assert from 'node:assert/strict'

export const windowsTaskChatRegion = '.ds-message-timeline-content section[aria-label="任务"]'

/** Read the visible task in its originating conversation with debug-only task pages excluded. */
export function windowsTaskChatLayoutExpression(marker) {
  return `(() => {
    const composer=document.querySelector('.ds-chat-composer-dock');
    const status=document.querySelector(${JSON.stringify(windowsTaskChatRegion)});
    const timeline=document.querySelector('.ds-message-timeline-content');
    if(!composer?.querySelector('textarea')?.getClientRects().length||!status?.getClientRects().length||!timeline)return null;
    const taskLabels=new Set(['继续任务','继续原任务','重新检查并继续原任务','取消任务','暂停','重试','允许','拒绝','授权并继续','提交','清空步骤']);
    const bottomControls=new Set(composer.querySelectorAll('section[aria-label="任务"], .ds-chat-task-context, select[aria-label$="的状态"]'));
    for(const button of composer.querySelectorAll('button'))if(taskLabels.has(button.textContent.trim()))bottomControls.add(button);
    for(const summary of composer.querySelectorAll('details > summary'))if(summary.textContent.includes('执行步骤'))bottomControls.add(summary);
    for(const textarea of [...composer.querySelectorAll('textarea')].slice(1))bottomControls.add(textarea);
    const navigation=[...document.querySelectorAll('nav[aria-label="工作区工具"] button')];
    return { surface:'original-chat', originalPrompt:timeline.textContent.includes(${JSON.stringify(marker)}),
      taskInTranscript:timeline.contains(status)&&!composer.contains(status), composerTaskControlCount:bottomControls.size,
      taskListCount:document.querySelectorAll('[aria-label="任务列表"], .ds-task-sidebar, .ds-task-workspace').length,
      taskNavigationCount:navigation.filter(button=>button.textContent.trim()==='任务'||button.getAttribute('aria-label')==='任务').length,
      taskWorkbenchLinks:[...document.querySelectorAll('button')].filter(button=>button.textContent.trim()==='打开任务工作台').length,
      width:status.getBoundingClientRect().width, overflow:status.scrollWidth-status.clientWidth };
  })()`
}

export function validateWindowsTaskChatLayout(layout) {
  assert.equal(layout?.surface, 'original-chat')
  assert.equal(layout.originalPrompt, true)
  assert.equal(layout.taskInTranscript, true, 'Task status and controls must be inserted in the message transcript')
  assert.equal(layout.composerTaskControlCount, 0, 'The bottom draft must contain no associated task, approval, question or checklist controls')
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
