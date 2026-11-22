import * as React from "react";
import type { SettingsContext } from "../settings-context.js";
import { DiscordSection, OneBotSection } from "./connections.js";
import { GroupsForm } from "./groups.js";
import { GithubSection } from "./github.js";
import { CHANNEL_CSS } from "./styles.js";

export function ChannelsSection(ctx: SettingsContext & { section: string }) {
  const Form = { onebot: OneBotSection, discord: DiscordSection, github: GithubSection, groups: GroupsForm }[ctx.section];
  return Form ? <section className="synapse-channels"><style>{CHANNEL_CSS}</style><Form {...ctx}/></section> : null;
}
