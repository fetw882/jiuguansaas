export const config = {
  basePath: '/st',
  injectBase: '/st-inject',
  // Upstream SillyTavern server (optional for fallback). Example: http://127.0.0.1:8000
  upstreamBase: process.env.ST_UPSTREAM_BASE || '',
  // Enable fallback to upstream for unmapped API endpoints
  enableUpstreamFallback: process.env.ST_ENABLE_FALLBACK === 'true',
  // Strict mode for tests: for endpoints in KillList, forbid fallback
  killListEnabled: process.env.ST_KILLLIST === 'true',
  // Enforce entitlements on login (402 if expired/missing)
  enforceRightsOnLogin: process.env.ENFORCE_RIGHTS_ON_LOGIN !== 'false',
  // Inject a Chinese system instruction when UI language is zh-*
  injectChineseOnZhUI: process.env.INJECT_CHINESE_IF_ZH !== 'false',
  chineseInstructionText: process.env.CHINESE_INSTRUCTION_TEXT || '请用中文回复',
  // Optionally force the model to prioritize the latest user message over persona/opening chit-chat
  forceUserPriority: process.env.FORCE_USER_PRIORITY !== 'false',
  // Extra guidance text appended to system instruction when forceUserPriority is enabled
  userPriorityTextZH: process.env.USER_PRIORITY_TEXT_ZH || '请直接回应用户最新一句，不要重复开场白；如与设定冲突，以用户最新请求为准。若用户提出计算或事实问题，请直接给出结果。',
  userPriorityTextEN: process.env.USER_PRIORITY_TEXT_EN || 'Directly respond to the latest user message without repeating greetings. If it conflicts with persona, prioritize the latest user request. For calculations or factual questions, answer directly.',
  // Roleplay/story enforcer (adds a gentle instruction to honor character card, world info, chat history)
  roleplayEnforcer: process.env.ROLEPLAY_ENFORCER === 'true',
  roleplayInstructionZH: process.env.ROLEPLAY_INSTRUCTION_ZH || '你正在扮演「{char}」，需遵循角色卡、世界观与当前聊天历史，不要重启对话或自我介绍，用中文并保持角色口吻自然回应「{user}」。',
  roleplayInstructionEN: process.env.ROLEPLAY_INSTRUCTION_EN || 'You are roleplaying as "{char}". Follow the character sheet, world info and current chat history. Do not restart the conversation or re-introduce yourself. Reply naturally in character to "{user}".',
  // Optionally inject character card fields (from gateway DB) into system instruction when char_name is known
  roleplayUseCharacterCard: process.env.ROLEPLAY_USE_CHARACTER_CARD === 'true',
  roleplayCardTemplateZH: process.env.ROLEPLAY_CARD_TEMPLATE_ZH || '角色卡（精要）：\n姓名：{name}\n设定：{description}\n性格：{personality}\n场景：{scenario}\n开场示例：{first_mes}',
  roleplayCardTemplateEN: process.env.ROLEPLAY_CARD_TEMPLATE_EN || 'Character Card (Brief):\nName: {name}\nDescription: {description}\nPersonality: {personality}\nScenario: {scenario}\nFirst Message Example: {first_mes}',
  // World Info injection (brief)
  roleplayUseWorldInfo: process.env.ROLEPLAY_USE_WORLD_INFO === 'true',
  roleplayWorldItems: Number(process.env.ROLEPLAY_WORLD_ITEMS || 3),
  roleplayWorldTemplateZH: process.env.ROLEPLAY_WORLD_TEMPLATE_ZH || '世界观（精要，最多{n}条）：\n{items}',
  roleplayWorldTemplateEN: process.env.ROLEPLAY_WORLD_TEMPLATE_EN || 'World Info (brief, up to {n}):\n{items}',
  roleplayWorldItemBulletZH: process.env.ROLEPLAY_WORLD_ITEM_BULLET_ZH || '- {text}',
  roleplayWorldItemBulletEN: process.env.ROLEPLAY_WORLD_ITEM_BULLET_EN || '- {text}',
  // Safety clamps for injected texts
  personaClampChars: Number(process.env.PERSONA_CLAMP_CHARS || 1200),
  worldClampChars: Number(process.env.WORLD_CLAMP_CHARS || 800),
  // Strict latest-intent focus (collapse to last user only)
  strictLatestOnly: process.env.STRICT_LATEST_ONLY === 'true',
  // In strict mode, drop persona/world/system text (keep only minimal guidance)
  strictLatestDropPersona: process.env.STRICT_LATEST_DROP_PERSONA === 'true',
  // Chat history window (non-system turns)
  chatHistoryTurns: Number(process.env.CHAT_HISTORY_TURNS || 8),
  // Latest intent anchoring (force model to incorporate the last user utterance)
  intentAnchor: process.env.INTENT_ANCHOR !== 'false',
  intentAnchorClamp: Number(process.env.INTENT_ANCHOR_CLAMP || 400),
  intentAnchorTextZH: process.env.INTENT_ANCHOR_TEXT_ZH || '最新用户意图（最高优先级）：「{lastUser}」。请紧扣此意图推进剧情，不要寒暄或重启。',
  intentAnchorTextEN: process.env.INTENT_ANCHOR_TEXT_EN || 'Latest user intent (highest priority): "{lastUser}". Please stick to it to advance the scene without small talk or restarts.',
  // Hard append of latest user intent as a synthetic user turn at the end
  hardIntentAppend: process.env.HARD_INTENT_APPEND !== 'false',
  hardIntentSuffixZH: process.env.HARD_INTENT_SUFFIX_ZH || '（请直接据此回应）',
  hardIntentSuffixEN: process.env.HARD_INTENT_SUFFIX_EN || ' (please respond to this directly)',
  // Intent rules (lightweight heuristics fully compatible with ST prompts)
  intentRuleMath: process.env.INTENT_RULE_MATH !== 'false',
  intentRuleMathTextZH: process.env.INTENT_RULE_MATH_TEXT_ZH || '如果最新意图包含算式或“只回答数字”，仅输出阿拉伯数字结果。',
  intentRuleMathTextEN: process.env.INTENT_RULE_MATH_TEXT_EN || 'If the latest intent contains a formula or requests numbers only, output only the numeric result.',
  intentRuleStory: process.env.INTENT_RULE_STORY !== 'false',
  intentRuleStoryTextZH: process.env.INTENT_RULE_STORY_TEXT_ZH || '如果最新意图包含“剧情推进/继续剧情/采取行动”，请立刻在既有世界观内执行下一步具体行动，避免寒暄与重启。',
  intentRuleStoryTextEN: process.env.INTENT_RULE_STORY_TEXT_EN || 'If the latest intent says to advance/continue/act, immediately take the next concrete action within the existing world without small talk or restarts.',
  // Scrub SillyTavern meta prompts like [Start a new Chat] from payload text
  scrubStMetaPrompts: process.env.SCRUB_ST_META_PROMPTS !== 'false',
  // Output token caps (to avoid upstream 400/413 on large max_tokens)
  geminiMaxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 1024),
  openaiCompatMaxTokens: Number(process.env.OPENAI_COMPAT_MAX_TOKENS || 1024),
  // Upstream retry policy for transient errors
  geminiRetryCount: Number(process.env.GEMINI_RETRY_COUNT || 2),
  geminiRetryDelayMs: Number(process.env.GEMINI_RETRY_DELAY_MS || 400),
};
