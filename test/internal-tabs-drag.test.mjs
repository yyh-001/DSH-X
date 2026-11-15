import assert from 'node:assert/strict'
import test from 'node:test'
import { internalTabs } from './helpers/internal-tabs-dom.mjs'

const actions = (h, name) => h.sent.filter((message) => message.action === name)

test('未达拖动门槛的原生捕获 click 激活原标签，新旧外壳能力与鼠标修饰键均保留一次选择', () => {
  for (const capability of [{}, { live:true }, { deferred:true }, { drag:false }, { supported:false }]) {
    for (const modifiers of [{}, { ctrlKey:true }, { metaKey:true }, { shiftKey:true }, { altKey:true }]) {
      const h = internalTabs()
      h.update({ active:'c', detach:{ supported:true,drag:true,merge:true,...capability } })
      h.tick(); h.down('a',modifiers); h.move('a',{clientX:153,...modifiers})
      const click = h.releaseClick('a',{clientX:153,...modifiers})
      assert.equal(click.target,h.item('a').querySelector('.internal-tab-label'))
      assert.deepEqual(actions(h,'select').map(action=>action.id),['a'])
      assert.equal(actions(h,'tab-drag').length,0)
      assert.equal(actions(h,'reorder').length,0)
      assert.equal(h.captureTarget(),null)
    }
  }
})

test('真正开始拖动才交给稳定列表捕获，旧按钮 lostcapture 不取消；松手 click 不选中或关闭标签', () => {
  for (const capability of [{live:true},{deferred:true}]) {
    const h = internalTabs()
    h.update({active:'c',detach:{supported:true,drag:true,merge:true,...capability}})
    h.down('a')
    assert.equal(h.captureTarget(),h.item('a').querySelector('.internal-tab-label'))
    h.move('a',{clientX:156})
    assert.equal(h.captureTarget(),h.list)
    assert.equal(actions(h,'tab-drag').filter(action=>action.active).length,1)
    assert.equal(actions(h,'tab-drag').some(action=>action.cancel),false)
    const click = h.releaseClick('a',{clientX:156})
    assert.equal(click.target,h.list)
    assert.equal(actions(h,'select').length,0)
    assert.equal(actions(h,'close-tab').length,0)
    assert.equal(actions(h,'tab-drag').filter(action=>action.active===false).length,1)
  }
})

test('门槛前取消也阻止迟到 click 选择，门槛后仍安全取消并允许下一次普通点击', () => {
  for (const started of [false,true]) {
    for (const kind of ['Escape','blur','pointercancel','lostpointercapture','hide']) {
      const h = internalTabs()
      h.update({active:'c',detach:{supported:true,drag:true,merge:true,deferred:true}})
      h.down('a'); if(started)h.move('a',{clientX:156})
      if(kind==='Escape')h.document.emit('keydown',h.event('a',{key:'Escape'}))
      else if(kind==='blur')h.window.emit('blur',{})
      else if(kind==='pointercancel')h.document.emit('pointercancel',h.event('a'))
      else if(kind==='hide')h.window.cancelTabDrag()
      else h.list.emit('lostpointercapture',h.event('a',{target:h.captureTarget()}))
      h.advanceTime(1_000); h.releaseClick('a')
      assert.equal(actions(h,'select').length,0,`${kind}, started=${started}`)
      assert.equal(actions(h,'tab-drag').filter(action=>action.active===false&&!action.cancel).length,0)
      h.down('b',{clientX:350}); h.releaseClick('b',{clientX:350})
      assert.deepEqual(actions(h,'select').map(action=>action.id),['b'])
    }
  }
})

test('菜单/关闭按钮不进入标签捕获，触摸与笔保持普通点击和仅排序，键盘激活不依赖指针', () => {
  for (const selector of ['.internal-tab-close','.internal-tab-menu']) {
    const h = internalTabs()
    h.update({detach:{supported:true,drag:true,merge:true,deferred:true}})
    const target=h.item('b').querySelector(selector)
    h.down('b',{target}); assert.equal(h.captureTarget(),null)
    h.releaseClick('b',{target})
    assert.equal(actions(h,'select').length,0)
    assert.equal(actions(h,selector.endsWith('close')?'close-tab':'tab-menu').length,1)
  }
  for(const pointerType of ['touch','pen']) {
    const h=internalTabs()
    h.update({active:'c',detach:{supported:true,drag:true,merge:true,deferred:true}})
    h.down('a',{pointerType}); h.releaseClick('a',{pointerType})
    assert.deepEqual(actions(h,'select').map(action=>action.id),['a'])
    h.down('b',{pointerType}); h.move('b',{pointerType,clientX:650}); h.releaseClick('b',{pointerType,clientX:650})
    assert.equal(actions(h,'select').length,1)
    assert.equal(actions(h,'detach-tab').length,0)
    assert.equal(actions(h,'tab-drag').some(action=>action.active),false)
    assert.equal(actions(h,'reorder').length,1)
  }
  const h=internalTabs()
  h.activate('b')
  assert.deepEqual(actions(h,'select').map(action=>action.id),['b'])
})

test('取消后键盘仍可激活，迟到物理 click 不重复选择；新按下的关闭/菜单按钮不被旧取消吞掉', () => {
  for(const selector of ['.internal-tab-close','.internal-tab-menu']) {
    const h=internalTabs()
    h.update({active:'c',detach:{supported:true,drag:true,merge:true,deferred:true}})
    h.down('a'); h.document.emit('keydown',h.event('a',{key:'Escape'}))
    h.advanceTime(1_000); h.activate('a'); h.releaseClick('a')
    assert.deepEqual(actions(h,'select').map(action=>action.id),['a'])
    h.down('b'); h.window.cancelTabDrag()
    const target=h.item('b').querySelector(selector)
    h.down('b',{target}); h.releaseClick('b',{target})
    assert.equal(actions(h,selector.endsWith('close')?'close-tab':'tab-menu').length,1)
    assert.equal(actions(h,'select').length,1)
  }
})

test('旧核心拖出等待回执且未生成拖后 click 时，新的关闭按钮仍可用但不再开启拖动', () => {
  const h=internalTabs()
  h.update({detach:{supported:true,drag:true,merge:true}})
  h.down('a'); h.move('a',{clientY:100}); h.up('a',{clientY:100})
  assert.equal(actions(h,'detach-tab').length,1)
  const target=h.item('a').querySelector('.internal-tab-close')
  h.down('a',{target}); h.releaseClick('a',{target})
  assert.deepEqual(actions(h,'close-tab').map(action=>action.id),['a'])
  assert.equal(actions(h,'select').length,0)
  h.down('b'); h.move('b',{clientY:100}); h.up('b',{clientY:100})
  assert.equal(actions(h,'detach-tab').length,1,'等待旧回执时仍拒绝新拖动')
})

test('延迟提交顶栏按帧上报局部坐标，最终排序和跨窗只发送一条松手命令', () => {
  const h = internalTabs()
  h.update({ detach: { supported:true, drag:true, merge:true, deferred:true } })
  h.tick(); h.down('a')
  for (let i = 0; i < 50; i++) h.move('a', { clientX:600+i }, false)
  assert.equal(actions(h,'tab-drag-move').length,0)
  h.tick()
  assert.equal(actions(h,'tab-drag-move').length,1)
  h.up('a', { clientX:650,clientY:25 })
  const end = actions(h,'tab-drag').at(-1)
  assert.deepEqual(end.order,['b','c','a'])
  assert.deepEqual(end.point,{ x:650,y:25 })
  assert.equal(end.deferred,true)
  assert.equal(end.cancel,false)
  assert.equal(h.list.pointer,null)
  assert.equal(actions(h,'reorder').length,0)
  assert.equal(actions(h,'detach-tab').length,0)
})

test('外壳显式取消释放列表捕获；隐藏后的迟到 up 不重复提交且可再次开始', () => {
  const h = internalTabs()
  h.update({ detach: { supported:true,drag:true,merge:true,deferred:true } })
  h.down('a'); h.move('a', { clientY:100 })
  h.window.cancelTabDrag()
  assert.equal(h.list.pointer,null)
  assert.equal(actions(h,'tab-drag').at(-1).cancel,true)
  const count = actions(h,'tab-drag').length
  h.up('a', { clientY:100 })
  assert.equal(actions(h,'tab-drag').length,count)
  h.down('b'); h.move('b', { clientY:100 })
  assert.equal(h.list.pointer,1)
  h.document.hidden = true; h.document.emit('visibilitychange',{})
  assert.equal(h.list.pointer,null)
  assert.equal(actions(h,'tab-drag').at(-1).cancel,true)
})

test('实时拖动捕获列表，标签移走仍继续接收鼠标，松手只提交事务', () => {
  const h = internalTabs()
  h.update({ detach: { supported: true, drag: true, merge: true, live: true } })
  h.down('a'); h.move('a', { clientY: 100 })
  assert.equal(h.list.pointer, 1)
  assert.equal(actions(h, 'tab-drag')[0].live, true)
  h.update({ dragging: 'a', tabs: h.state.tabs.filter((tab) => tab.id !== 'a') })
  assert.equal(actions(h, 'tab-drag').length, 1, '源节点消失不取消捕获')
  h.move('b', { clientX: 800, clientY: 100 })
  h.up('b', { clientX: 800, clientY: 100 })
  const end = actions(h, 'tab-drag').at(-1)
  assert.equal(end.id, 'a')
  assert.equal(end.cancel, false)
  assert.equal(end.active, false)
  assert.equal(actions(h, 'detach-tab').length, 0)
})

test('实时移交后 Escape、blur 和捕获丢失均向原事务发送撤销', () => {
  for (const kind of ['keydown', 'blur', 'lostpointercapture']) {
    const h = internalTabs()
    h.update({ detach: { supported: true, drag: true, merge: true, live: true } })
    h.down('a'); h.move('a', { clientY: 100 })
    h.update({ dragging: 'a', tabs: [] })
    if (kind === 'keydown') h.document.emit(kind, h.event('a', { key: 'Escape' }))
    else if (kind === 'blur') h.window.emit(kind, {})
    else h.list.emit(kind, h.event('a', { target: h.list }))
    assert.equal(actions(h, 'tab-drag').at(-1).cancel, true)
    assert.equal(actions(h, 'detach-tab').length, 0)
    assert.equal(h.list.pointer, null)
  }
})

test('窗口抓取点取自按下时的标签位置，窗口跟随后不再叠加标签位移', () => {
  const h = internalTabs()
  h.update({ detach: { supported: true, drag: true, merge: true, live: true } })
  h.down('b', { clientX: 450, clientY: 22 })
  h.move('b', { clientX: 480, clientY: 22 })
  assert.deepEqual(actions(h, 'tab-drag')[0].grab, { x: 150, y: 12, width: 200, height: 30, clientX: 450, clientY: 22 })
  h.update({ floating: 'b', dragging: 'b' })
  h.move('b', { clientX: 490, clientY: 22 })
  assert.equal(h.item('b').style.transform, undefined)
})

test('高频移动合并到显示帧，静止和取消后不再持续读布局', () => {
  const h = internalTabs()
  h.tick()
  h.down('a')
  const before = h.metrics.reads
  for (let i = 0; i < 100; i++) h.move('a', { clientX: 150 + i }, false)
  assert.equal(h.metrics.reads, before, '鼠标事件只更新坐标，不立即测量布局')
  assert.equal(h.pendingFrames(), 1)
  h.tick()
  assert.ok(h.metrics.reads > before)
  assert.equal(h.pendingFrames(), 0, '未处于滚动边缘时不空转')
  const idle = h.metrics.reads
  for (let i = 0; i < 60; i++) h.tick()
  assert.equal(h.metrics.reads, idle)
  h.move('a', { clientY: 100 }, false)
  h.document.emit('keydown', h.event('a', { key: 'Escape' }))
  assert.equal(h.pendingFrames(), 0)
  assert.equal(actions(h, 'detach-tab').length, 0)
})

test('松手在尚未绘制的移动帧之前到达，仍按最终位置排序和取消续帧', () => {
  const h = internalTabs()
  h.tick(); h.down('a'); h.move('a', { clientX: 650 }, false)
  h.up('a', { clientX: 650 })
  assert.deepEqual(h.ids(), ['b', 'c', 'a'])
  assert.equal(actions(h, 'reorder').length, 1)
  assert.equal(h.pendingFrames(), 0)
})

test('方向键与首尾键只移动键盘焦点，激活和 Alt 排序仍使用原命令', () => {
  const h = internalTabs()
  const label = (id) => h.item(id).querySelector('.internal-tab-label')
  assert.equal(label('a').tabIndex, 0)
  assert.equal(label('b').tabIndex, -1)
  label('a').focus()
  h.document.emit('keydown', h.event('a', { key: 'ArrowLeft' }))
  assert.equal(h.document.activeElement, label('c'))
  assert.equal(actions(h, 'select').length, 0)
  h.update()
  assert.equal(label('c').tabIndex, 0, '后台状态回执不打断键盘焦点')
  h.document.emit('keydown', h.event('c', { key: 'Home' }))
  assert.equal(h.document.activeElement, label('a'))
  h.document.emit('keydown', h.event('a', { key: 'End' }))
  assert.equal(h.document.activeElement, label('c'))
  label('c').onclick()
  assert.equal(actions(h, 'select').at(-1).id, 'c')
  h.document.emit('keydown', h.event('c', { key: 'ArrowLeft', altKey: true }))
  assert.deepEqual(h.ids(), ['a', 'c', 'b'])
  assert.equal(actions(h, 'reorder').length, 1)
})

test('减少动画仍完成排序及新标签插入，但不创建动画对象', () => {
  for (const reducedMotion of [true, false]) {
    const h = internalTabs({ reducedMotion })
    h.down('a'); h.move('a', { clientX: 650 }); h.up('a', { clientX: 650 })
    h.update({ tabs: [...h.state.tabs, { id: 'd', title: 'd' }] })
    assert.deepEqual(h.ids(), ['b', 'c', 'a', 'd'])
    assert.equal(h.metrics.animations > 0, !reducedMotion)
  }
})

test('独立顶栏跟随应用减少动画设置，不依赖操作系统开启', () => {
  const h = internalTabs({ reducedMotion: false })
  h.update({ standalone: true, reduceMotion: true })
  const before = h.metrics.animations
  h.update({ tabs: [...h.state.tabs, { id: 'd', title: 'd' }] })
  assert.equal(h.metrics.animations, before)
  h.update({ reduceMotion: false, tabs: [...h.state.tabs, { id: 'e', title: 'e' }] })
  assert.ok(h.metrics.animations > before)
})

test('可合并窗口报告可见标签坐标，拖动开始和取消同步外壳、清除提示', () => {
  const h = internalTabs()
  h.update({ detach: { supported: true, drag: true, merge: true } })
  const strip = actions(h, 'tab-strip').at(-1)
  assert.equal(strip.tabs.length, 3)
  assert.equal(strip.rect.left, 100)
  h.down('a'); h.move('a', { clientY: 100 })
  assert.equal(actions(h, 'tab-drag').at(-1).active, true)
  h.window.updateTabDrop({ merging: true })
  const hint = h.document.getElementById('internalTabsArea').querySelector('.internal-tab-hint')
  assert.equal(hint.textContent, '松手并入此窗口')
  h.document.emit('keydown', h.event('a', { key: 'Escape' }))
  assert.equal(actions(h, 'tab-drag').at(-1).active, false)
  assert.equal(hint.hidden, true)
  assert.equal(actions(h, 'detach-tab').length, 0)
})

test('接收目标反馈后，源窗口松手仍走统一迁移命令', () => {
  const h = internalTabs()
  h.update({ standalone: true, detach: { supported: true, drag: true, merge: true } })
  h.window.updateTabDrop({ marker: 250 })
  h.window.updateTabDrop(null)
  h.down('a'); h.move('a', { clientY: 100 }); h.up('a', { clientY: 100 })
  assert.equal(actions(h, 'detach-tab').length, 1)
  assert.equal(actions(h, 'tab-drag').length, 1, '提交前不取消主进程的落点提示')
})

test('纵向拖出只在松手提交一次，途中排序不保存，拖动产生的点击被抑制', () => {
  const h = internalTabs()
  h.down('a')
  h.move('a', { clientX: 650 })
  assert.deepEqual(h.ids(), ['b', 'c', 'a'])
  h.move('a', { clientX: 650, clientY: 65 })
  assert.equal(h.item('a').classList.contains('detach-ready'), true)
  assert.match(h.list.parentNode.querySelector('.internal-tab-hint').textContent, /松手/)
  assert.equal(actions(h, 'detach-tab').length, 0)
  h.up('a', { clientX: 650, clientY: 65 })
  assert.deepEqual(h.ids(), ['a', 'b', 'c'])
  assert.equal(actions(h, 'detach-tab').length, 1)
  assert.equal(actions(h, 'reorder').length, 0)
  const click = h.event('a')
  h.list.emit('click', click)
  assert.ok(click.prevented)
})

test('5px 启动门槛、24px 拖出和 8px 返回迟滞：回到栏内继续排序', () => {
  const h = internalTabs()
  h.down('a')
  h.move('a', { clientY: 29 })
  assert.equal(h.list.classList.contains('dragging'), false)
  h.move('a', { clientY: 30 })
  assert.equal(h.list.classList.contains('dragging'), true)
  h.move('a', { clientY: 64 })
  assert.equal(h.item('a').classList.contains('detach-ready'), false)
  h.move('a', { clientY: 65 })
  h.move('a', { clientY: 55 })
  assert.equal(h.item('a').classList.contains('detach-ready'), true)
  h.move('a', { clientY: 48, clientX: 650 })
  assert.equal(h.item('a').classList.contains('detach-ready'), false)
  h.up('a', { clientX: 650 })
  assert.deepEqual(h.ids(), ['b', 'c', 'a'])
  assert.equal(actions(h, 'reorder').length, 1)
  assert.equal(actions(h, 'detach-tab').length, 0)
})

test('最后一次 pointerup 坐标决定是否拆窗；横向越过窗口边缘也能拆出', () => {
  for (const point of [{ clientY: -15 }, { clientX: -25 }, { clientX: 1025 }]) {
    const h = internalTabs()
    h.down('a'); h.move('a', { clientX: 160 }); h.up('a', point)
    assert.equal(actions(h, 'detach-tab').length, 1)
  }
})

test('首尾自动滚动不是拆窗，候选状态暂停滚动', () => {
  const h = internalTabs()
  h.list.bounds.right = 500
  h.list.bounds.width = 400
  h.down('a'); h.move('a', { clientX: 510 }); h.tick()
  assert.ok(h.list.scrollLeft > 0)
  assert.equal(h.item('a').classList.contains('detach-ready'), false)
  h.move('a', { clientX: 510, clientY: 80 })
  const before = h.list.scrollLeft
  h.tick()
  assert.equal(h.list.scrollLeft, before)
})

test('Escape、失焦、失去捕获和 pointercancel 恢复顺序、不拆窗', () => {
  for (const cancel of ['Escape', 'blur', 'lostpointercapture', 'pointercancel']) {
    const h = internalTabs()
    h.down('a'); h.move('a', { clientX: 550 }); h.move('a', { clientY: 90 })
    if (cancel === 'Escape') h.document.emit('keydown', h.event('a', { key: 'Escape' }))
    else if (cancel === 'blur') h.window.emit('blur', {})
    else if (cancel === 'lostpointercapture') h.list.emit(cancel, h.event('a'))
    else h.document.emit(cancel, h.event('a'))
    h.up('a', { clientY: 90 })
    assert.deepEqual(h.ids(), ['a', 'b', 'c'])
    assert.equal(actions(h, 'detach-tab').length, 0)
    assert.equal(actions(h, 'reorder').length, 0)
  }
})

test('拖动中新增标签保留在末尾，关闭被拖标签取消操作', () => {
  const h = internalTabs()
  h.down('a'); h.move('a', { clientX: 550, clientY: 90 })
  h.update({ tabs: [...h.state.tabs, { id: 'd', title: 'd' }] })
  h.document.emit('keydown', h.event('a', { key: 'Escape' }))
  assert.deepEqual(h.ids(), ['a', 'b', 'c', 'd'])
  h.down('a'); h.move('a', { clientY: 90 })
  h.update({ tabs: h.state.tabs.filter((tab) => tab.id !== 'a') })
  h.up('b', { clientY: 90 })
  assert.equal(actions(h, 'detach-tab').length, 0)
})

test('旧外壳不展示菜单，Wayland 保留菜单和排序，触摸不使用鼠标坐标拆窗', () => {
  for (const patch of [{ detach: undefined }, { detach: { supported: true, drag: false } }]) {
    const h = internalTabs(); h.update(patch)
    assert.equal(h.item('a').querySelector('.internal-tab-menu').hidden, !patch.detach)
    h.down('a'); h.move('a', { clientX: 550, clientY: 90 }); h.up('a', { clientX: 550, clientY: 90 })
    assert.equal(actions(h, 'detach-tab').length, 0)
    assert.equal(actions(h, 'reorder').length, 1)
  }
  const h = internalTabs()
  h.down('a', { pointerType: 'touch' }); h.move('a', { clientY: 90 }); h.up('a', { clientY: 90 })
  assert.equal(actions(h, 'detach-tab').length, 0)
})

test('菜单按钮、右键、Shift+F10 和菜单键作用于目标标签，取消或失败解除忙碌', () => {
  for (const method of ['button', 'contextmenu', 'F10', 'ContextMenu']) {
    const h = internalTabs()
    const menu = h.item('b').querySelector('.internal-tab-menu')
    h.down('b', { target: menu }); h.move('b', { clientY: 100 }); h.up('b', { clientY: 100 })
    assert.equal(actions(h, 'detach-tab').length, 0)
    if (method === 'button') menu.onclick()
    else if (method === 'contextmenu') h.item('b').oncontextmenu(h.event('b'))
    else h.document.emit('keydown', h.event('b', { key: method, shiftKey: true }))
    const request = actions(h, 'tab-menu')[0]
    assert.equal(request.id, 'b')
    menu.onclick()
    assert.equal(actions(h, 'tab-menu').length, 1)
    h.update({ detachResult: { id: 'b', request: request.request, status: 'cancelled' } })
    assert.equal(h.item('b').attributes['aria-busy'], undefined)
    menu.onclick()
    const next = actions(h, 'tab-menu')[1]
    h.update({ detachResult: { id: 'b', request: next.request, status: 'error' } })
    h.update()
    assert.equal(h.errors.length, 1)
    assert.deepEqual(h.ids(), ['a', 'b', 'c'])
  }
})
