import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { validateWindowsTaskChatLayout, windowsTaskChatLayoutExpression } from './windows-task-chat-ui.mjs'

function fixture(window) {
  window.document.body.innerHTML = '<main><div class="ds-message-timeline-content"><article><p>原任务合成查询</p><section aria-label="任务"><button>继续任务</button></section></article></div><div class="ds-chat-composer-dock"><textarea placeholder="向智能体提问…"></textarea><button aria-label="发送">发送</button></div><nav aria-label="工作区工具"></nav></main>'
  for (const node of window.document.querySelectorAll('section, textarea')) {
    node.getClientRects = () => [{ width: 410, height: 80 }]
    node.getBoundingClientRect = () => ({ width: 410, height: 80 })
  }
  return () => window.eval(windowsTaskChatLayoutExpression('原任务合成查询'))
}

test('the real DOM probe accepts task insertion in transcript and an independent clean draft', async () => {
  const window = new Window()
  try {
    const observe = fixture(window), result = observe()
    assert.equal(result.taskInTranscript, true)
    assert.equal(result.composerTaskControlCount, 0)
    validateWindowsTaskChatLayout(result)
  } finally { await window.happyDOM.close() }
})

test('the DOM probe cannot accept the former task placement above the draft', async () => {
  const window = new Window()
  try {
    const observe = fixture(window)
    window.document.querySelector('.ds-chat-composer-dock').prepend(window.document.querySelector('section'))
    assert.equal(observe(), null)
    assert.throws(() => validateWindowsTaskChatLayout({ surface:'original-chat', originalPrompt:true, taskInTranscript:false, composerTaskControlCount:1, taskListCount:0, taskNavigationCount:0, taskWorkbenchLinks:0, width:410, overflow:0 }))
  } finally { await window.happyDOM.close() }
})

for (const markup of ['<button>授权并继续</button>', '<button>允许</button>', '<button>提交</button>', '<details><summary>执行步骤 · 已完成 0 / 1</summary></details>', '<select aria-label="合成步骤的状态"></select>', '<textarea aria-label="回答问题"></textarea>']) {
  test(`the clean-draft contract rejects an associated control: ${markup}`, async () => {
    const window = new Window()
    try {
      const observe = fixture(window)
      window.document.querySelector('.ds-chat-composer-dock').insertAdjacentHTML('beforeend', markup)
      const result = observe()
      assert.equal(result.composerTaskControlCount, 1)
      assert.throws(() => validateWindowsTaskChatLayout(result), /bottom draft/)
    } finally { await window.happyDOM.close() }
  })
}

test('old reports without transcript and clean-draft observations cannot pass the new contract', () => {
  assert.throws(() => validateWindowsTaskChatLayout({ surface:'original-chat', originalPrompt:true, taskListCount:0, taskNavigationCount:0, taskWorkbenchLinks:0, width:410, overflow:0 }), /message transcript/)
})
