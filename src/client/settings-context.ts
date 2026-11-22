import type { ConfigPanelProps } from "@dsh-plugin/dsh-loader/client";
import type { SynapseConfig } from "../types.js";

export type Edit = (previous: SynapseConfig) => SynapseConfig;

export interface SettingsContext extends ConfigPanelProps {
  value: SynapseConfig;
  setValue(edit: Edit): void;
  commit(edit: Edit): Promise<void>;
  saving: boolean;
  route: string;
  navigate(path: string): void;
  refresh(): Promise<void>;
}
