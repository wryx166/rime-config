-- 候选词黑名单过滤器（librime-lua 插件）
-- 挂载：rime_ice.custom.yaml 中 engine/filters/+: [lua_filter@*blacklist]
-- 生效：node scripts/deploy-rime.mjs --deploy 后重启输入法
-- 本文件为用户自有文件，更新上游 rime-ice 不会被覆盖

-- 国旗 emoji：任意国旗 = 两个连续的区域指示符（U+1F1E6–U+1F1FF），
-- UTF-8 下每个是 4 字节 F0 9F 87 A6–BF。Lua pattern 只能匹配字节，故按字节写
local FLAG_EMOJI = "\xF0\x9F\x87[\xA6-\xBF]\xF0\x9F\x87[\xA6-\xBF]"

-- 黑名单规则：候选词文本（去空格后）命中任意一条即屏蔽
-- 语法为 Lua pattern，与 PCRE 差异：无 \d（用 [0-9]）、特殊字符需 % 转义
local blacklist_patterns = {
  "哥伦比亚.+",
  "摸乳",
  "[毛苗]人[风凤]", 
  FLAG_EMOJI,              -- 所有国旗 emoji
  -- "🐶",                 -- 不要的 emoji 直接贴这里（任意位置命中即屏蔽）
}

-- 过滤器表：librime-lua 协议要求返回 { func = function(input, env) }，
-- input 逐个产出候选词，yield(cand) 放行一个候选词
local filter = {}

function filter.func(input, env)
  -- 遍历每个候选词
  for cand in input:iter() do
    -- 候选词文本去空格，方便匹配
    local text = cand.text:gsub("%s+", "")
    -- 是否命中黑名单
    local blocked = false

    -- 逐条匹配黑名单规则
    for _, pattern in ipairs(blacklist_patterns) do
      -- 命中任意一条即标记屏蔽
      if text:find(pattern) then
        blocked = true
        break
      end
    end

    -- 未命中则放行
    if not blocked then
      yield(cand)
    end
  end
end

return filter
