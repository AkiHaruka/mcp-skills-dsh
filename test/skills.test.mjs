import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  listSkills, getSkill, createSkill, setSkillEnabled, removeSkill,
  exportSkills, importSkills, splitFrontmatter, parseFrontmatter, rewriteFrontmatter,
  isKebabCase
} from '../lib/index.mjs'

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

// 本机定制 node 的 fs.cpSync 存在 native 崩溃，改用纯 JS 递归复制
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name)
    const d = path.join(dest, ent.name)
    if (ent.isDirectory()) copyDirSync(s, d)
    else fs.copyFileSync(s, d)
  }
}

function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-admin-skills-'))
  const dshHome = path.join(tmp, 'home')
  fs.mkdirSync(dshHome, { recursive: true })
  copyDirSync(FIX, dshHome)
  const sopts = { projectRoot: dshHome, agentsHome: dshHome, extraRoots: [] }
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  return { tmp, dshHome, sopts, skillsDir: path.join(dshHome, 'skills') }
}

test('listSkills 扫描目录 + 扁平两种形态，按 rank 排序', (t) => {
  const { dshHome, sopts } = setup(t)
  const list = listSkills(dshHome, sopts)
  assert.equal(list.length, 3)
  const names = list.map((s) => s.name)
  assert.ok(names.includes('alpha-skill'))
  assert.ok(names.includes('beta-skill'))
  assert.ok(names.includes('flat-skill'))
  const flat = list.find((s) => s.name === 'flat-skill')
  assert.match(flat.path, /flat-skill\.md$/, '扁平形态应为 <name>.md')
})

test('> 折叠块 description 正确解析，rawFrontmatter 保留原文', (t) => {
  const { dshHome, sopts } = setup(t)
  const alpha = listSkills(dshHome, sopts).find((s) => s.name === 'alpha-skill')
  assert.match(alpha.description, /Alpha 技能用于演示折叠块描述/)
  assert.match(alpha.description, /这里有多行文字/)
  assert.equal(alpha.description.includes('\n'), false, '> 折叠应把换行折成空格')
  assert.match(alpha.rawFrontmatter, /description: >/, '原文应保留 > 折叠标记')
  assert.match(alpha.rawFrontmatter, /metadata:/, '原文应保留 metadata')
  assert.equal(alpha.whenToUse, '需要盘点或调试本地 DSH 配置时')
  assert.equal(alpha.rank, 400)
})

test('parseFrontmatter 处理 key:value / > 折叠 / | 块 / 单双引号', (t) => {
  const fm = `---
name: demo
description: >
  第一行，
  第二行。
literal: |
  原始行一
  原始行二
single: '带: 冒号的值'
double: "带 # 井号的值"
bool1: true
num: 42
---
正文不动
`
  const p = splitFrontmatter(fm)
  assert.equal(p.hasFrontmatter, true)
  const obj = parseFrontmatter(p.fmText)
  assert.equal(obj.name, 'demo')
  assert.match(obj.description, /第一行， 第二行/)
  assert.match(obj.literal, /原始行一\n原始行二/)
  assert.equal(obj.single, '带: 冒号的值')
  assert.equal(obj.double, '带 # 井号的值')
  assert.equal(obj.bool1, true)
  assert.equal(obj.num, 42)
  assert.equal(p.body, '正文不动\n')
})

test('rewriteFrontmatter 只改 flag，保留其余 frontmatter 与正文（round-trip）', (t) => {
  const { dshHome, sopts } = setup(t)
  const beta = getSkill(dshHome, 'beta-skill', sopts)
  const beforeBody = beta.body
  const beforeMeta = beta.rawFrontmatter
  const next = rewriteFrontmatter(beta.content, {
    'disable-model-invocation': false,
    'user-invocable': true
  })
  const parts = splitFrontmatter(next)
  assert.equal(parts.body, beforeBody, '正文必须逐字节不变')
  assert.match(parts.fmText, /description: "Beta 技能：演示双引号描述与已停用 frontmatter"/, '双引号 description 原样保留')
  assert.match(parts.fmText, /disable-model-invocation: false/)
  assert.match(parts.fmText, /user-invocable: true/)
  assert.equal(parts.fmText.includes('metadata'), beforeMeta.includes('metadata'))
})

test('正文含 --- 与 | 的 skill 启停不破坏正文', (t) => {
  const { dshHome, sopts } = setup(t)
  const beta = getSkill(dshHome, 'beta-skill', sopts)
  const r = setSkillEnabled(dshHome, 'beta-skill', true, { apply: true, ...sopts })
  assert.equal(r.applied, true, r.error)
  const after = getSkill(dshHome, 'beta-skill', sopts)
  assert.equal(after.body, beta.body, '正文逐字节不变')
  assert.match(after.body, /\| --- \| --- \|/, '表格分隔线保留')
  assert.match(after.body, /正文里的 --- 和 \| 都必须原样保留/, '含 --- 的正文行保留')
  assert.equal(after.modelInvocable, true)
  assert.equal(after.userInvocable, true)
})

test('setSkillEnabled 启用/停用保留 > 折叠块、metadata 与正文', (t) => {
  const { dshHome, sopts } = setup(t)
  const before = getSkill(dshHome, 'alpha-skill', sopts)
  const dis = setSkillEnabled(dshHome, 'alpha-skill', false, { apply: true, ...sopts })
  assert.equal(dis.applied, true, dis.error)
  const mid = getSkill(dshHome, 'alpha-skill', sopts)
  assert.equal(mid.modelInvocable, false)
  assert.equal(mid.userInvocable, false)
  assert.match(mid.rawFrontmatter, /description: >/, '> 折叠块保留')
  assert.match(mid.rawFrontmatter, /metadata:/, 'metadata 保留')
  assert.equal(mid.body, before.body, '正文不变')
  assert.match(mid.rawFrontmatter, /disable-model-invocation: true/)
  assert.match(mid.rawFrontmatter, /user-invocable: false/)

  const en = setSkillEnabled(dshHome, 'alpha-skill', true, { apply: true, ...sopts })
  assert.equal(en.applied, true, en.error)
  const after = getSkill(dshHome, 'alpha-skill', sopts)
  assert.equal(after.modelInvocable, true)
  assert.equal(after.userInvocable, true)
  assert.equal(after.body, before.body)
})

test('dry-run 启停不落盘', (t) => {
  const { dshHome, sopts } = setup(t)
  const p = path.join(dshHome, 'skills', 'alpha-skill', 'SKILL.md')
  const before = fs.readFileSync(p, 'utf8')
  const r = setSkillEnabled(dshHome, 'alpha-skill', false, { ...sopts })
  assert.equal(r.applied, false)
  assert.equal(fs.readFileSync(p, 'utf8'), before)
  assert.match(r.diff, /disable-model-invocation/)
})

test('createSkill 写标准 frontmatter 且校验 kebab-case', (t) => {
  const { dshHome, sopts, skillsDir } = setup(t)
  assert.equal(isKebabCase('good-name-1'), true)
  assert.equal(isKebabCase('BadName'), false)
  assert.equal(isKebabCase('has_underscore'), false)
  assert.throws(() => createSkill(dshHome, 'BadName', { apply: true, ...sopts }), /kebab-case/)

  const r = createSkill(dshHome, 'gamma-skill', { description: '新技能：含: 冒号', whenToUse: '演示用', apply: true, ...sopts })
  assert.equal(r.applied, true, r.error)
  const s = getSkill(dshHome, 'gamma-skill', sopts)
  assert.equal(s.name, 'gamma-skill')
  assert.equal(s.description, '新技能：含: 冒号')
  assert.equal(s.whenToUse, '演示用')
  assert.equal(s.modelInvocable, true)
  assert.ok(fs.existsSync(path.join(skillsDir, 'gamma-skill', 'SKILL.md')))
  assert.throws(() => createSkill(dshHome, 'gamma-skill', { apply: true, ...sopts }), /已存在/)
})

test('removeSkill 移到备份目录而非硬删', (t) => {
  const { dshHome, sopts } = setup(t)
  const src = path.join(dshHome, 'skills', 'beta-skill')
  const dry = removeSkill(dshHome, 'beta-skill', { ...sopts })
  assert.equal(dry.applied, false)
  assert.ok(fs.existsSync(src), 'dry-run 不能删')

  const r = removeSkill(dshHome, 'beta-skill', { apply: true, ...sopts })
  assert.equal(r.applied, true, r.error)
  assert.equal(fs.existsSync(src), false)
  assert.ok(r.backupPath && fs.existsSync(r.backupPath), '备份目录应存在')
  assert.ok(fs.existsSync(path.join(r.backupPath, 'SKILL.md')), '备份里应有 SKILL.md')
  assert.equal(getSkill(dshHome, 'beta-skill', sopts), null)
})

test('export / import round-trip 保真', (t) => {
  const { tmp, dshHome, sopts } = setup(t)
  const exp = exportSkills(dshHome, sopts)
  assert.equal(exp.format, 'dsh-admin-skills/1')
  assert.equal(exp.skills.length, 3)
  assert.ok(exp.skills.every((s) => typeof s.content === 'string' && s.content.length > 0))

  const target = path.join(tmp, 'imported')
  fs.mkdirSync(target, { recursive: true })
  const opts2 = { projectRoot: target, agentsHome: target, extraRoots: [] }
  const dry = importSkills(target, JSON.stringify(exp), opts2)
  assert.equal(dry.applied, false)
  assert.equal(listSkills(target, opts2).length, 0, 'import dry-run 不落盘')

  const imp = importSkills(target, JSON.stringify(exp), { apply: true, ...opts2 })
  assert.equal(imp.applied, true, imp.error)
  const list = listSkills(target, opts2)
  assert.equal(list.length, 3)
  const a = getSkill(target, 'alpha-skill', opts2)
  assert.match(a.rawFrontmatter, /description: >/, '导入后 > 折叠仍保留')
  assert.equal(a.whenToUse, '需要盘点或调试本地 DSH 配置时')
})

test('重名 skill 按 rank 标注被遮蔽', (t) => {
  const { tmp, dshHome } = setup(t)
  const custom = path.join(tmp, 'custom')
  fs.mkdirSync(path.join(custom, 'alpha-skill'), { recursive: true })
  fs.writeFileSync(path.join(custom, 'alpha-skill', 'SKILL.md'),
    '---\nname: alpha-skill\ndescription: custom 同名\n---\n\n# C\n', 'utf8')
  const list = listSkills(dshHome, {
    projectRoot: dshHome, agentsHome: dshHome, extraRoots: [custom]
  }).filter((s) => s.name === 'alpha-skill')
  assert.equal(list.length, 2)
  assert.equal(list[0].shadowed, false, 'rank 小的胜出')
  assert.equal(list[0].rank, 300)
  assert.equal(list[1].shadowed, true, 'rank 大的被遮蔽')
  assert.equal(list[1].rank, 400)
  assert.ok(list[1].shadowedBy)
})
