import * as React from "react";
import { Button, Modal } from "@dsh-plugin/dsh-ui-components";
import type { SettingsContext } from "../settings-context.js";
import { SettingsFields, getFields } from "../preferences/fields.js";

export function MemorySettings({ ctx, skills = false, close }: { ctx: SettingsContext; skills?: boolean; close(): void }) {
  const [initial] = React.useState(ctx.value.memory);
  const [draft, setDraft] = React.useState(initial);
  const fields = getFields(ctx.view.template.fields, ["memory"]).filter(field =>
    Boolean(field.key) && (["learnSkills", "skillPrompt"].includes(field.key!) === skills)
  );
  function apply() {
    const changed = fields.filter(field => JSON.stringify(initial[field.key]) !== JSON.stringify(draft[field.key]));
    ctx.setValue(previous => ({
      ...previous, memory: { ...previous.memory, ...Object.fromEntries(changed.map(field => [field.key, draft[field.key]])) },
    }));
    close();
  }
  return <Modal visible title={skills ? "Skill 总结设置" : "记忆与检索设置"} onCancel={close} className="synapse-resource-modal" maskClosable={false}
    footer={<><Button variant="text" onClick={close}>取消</Button><Button variant="primary" onClick={apply}>应用到配置草稿</Button></>}>
    <SettingsFields fields={fields} path={["memory"]} ctx={{...ctx, value: { ...ctx.value, memory: draft }, setValue(edit) {
      setDraft(memory => edit({ ...ctx.value, memory }).memory);
    }}}/>
  </Modal>;
}
