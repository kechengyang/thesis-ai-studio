import React from 'react';
import { KeyRound, X } from 'lucide-react';

export function SettingsModal({
  deepseekApiKey,
  deepseekBaseUrl,
  isBusy,
  modelOptions,
  openaiApiKey,
  onClose,
  onSave,
  setDeepseekApiKey,
  setDeepseekBaseUrl,
  setOpenaiApiKey,
  setSettings,
  settings,
  switchProvider,
  providers,
}) {
  const selectedModel = modelOptions.find((item) => item.id === settings.model) || null;

  return (
    <div className="modal-backdrop">
      <section className="modal">
        <header>
          <h2>设置</h2>
          <button onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>
        <label>
          Provider
          <select
            value={settings.provider || 'openai'}
            onChange={(event) => switchProvider(event.target.value)}
          >
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          模型
          <select
            value={settings.model || modelOptions[0]?.id || ''}
            onChange={(event) => setSettings({ ...settings, model: event.target.value })}
          >
            {modelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
          {selectedModel?.description && <p className="field-hint">{selectedModel.description}</p>}
        </label>
        <label>
          OpenAI API Key
          <input
            type="password"
            value={openaiApiKey}
            placeholder={settings.openai_api_key_masked || 'sk-...'}
            onChange={(event) => setOpenaiApiKey(event.target.value)}
          />
        </label>
        <label>
          DeepSeek API Key
          <input
            type="password"
            value={deepseekApiKey}
            placeholder={settings.deepseek_api_key_masked || 'sk-...'}
            onChange={(event) => setDeepseekApiKey(event.target.value)}
          />
        </label>
        <label>
          DeepSeek Base URL
          <input
            value={deepseekBaseUrl}
            onChange={(event) => setDeepseekBaseUrl(event.target.value)}
          />
        </label>
        <label>
          推理强度
          <select
            value={settings.reasoning || 'medium'}
            onChange={(event) => setSettings({ ...settings, reasoning: event.target.value })}
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
          </select>
        </label>
        <label>
          Global Instruction
          <textarea
            rows={7}
            value={settings.instruction || ''}
            onChange={(event) => setSettings({ ...settings, instruction: event.target.value })}
          />
          <p className="field-hint">这会作为全局系统人设，影响 AI 改写和资料分析。留空时会恢复默认学者设定。</p>
        </label>
        <label>
          Word 模板
          <input
            value={settings.reference_doc || 'templates/reference.docx'}
            onChange={(event) => setSettings({ ...settings, reference_doc: event.target.value })}
          />
        </label>
        <button className="primary" onClick={onSave} disabled={isBusy}>
          <KeyRound size={18} />保存设置
        </button>
      </section>
    </div>
  );
}
