import axios, { AxiosResponse } from 'axios';
import { JSDOM } from 'jsdom';

export declare type Version = {
  success: boolean;
  latest: {
    release: string;
    snapshot: string;
  };
  versions: {
    id: string;
    type: string;
    url: string;
    time: string;
    releaseTime: string;
    sha1: string;
    complianceLevel: number;
  }[];
};

export declare type MinecraftServerStatus = {
  online: boolean;
  version: string;
  motd: string;
  players: { online: number; max: number; list: string[] };
};

export declare type WikiResult = {
  success: boolean;
  url: string;
  title: string;
  desc: string;
};

export class MinecraftAPI {
  private static readonly VERSION_MANIFEST_URL: string =
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

  public static async getVersion(): Promise<Version> {
    try {
      const res: AxiosResponse<{
        latest: {
          release: '';
          snapshot: '';
        };
        versions: [];
      }> = await axios.get(MinecraftAPI.VERSION_MANIFEST_URL);
      return {
        success: true,
        ...res.data
      };
    } catch (_) {
      return {
        success: false,
        latest: {
          release: '',
          snapshot: ''
        },
        versions: []
      };
    }
  }

  public static async getMinecraftServerStatus(ip: string, port?: number): Promise<MinecraftServerStatus> {
    try {
      if (ip.includes(':')) port = undefined;
      const res: AxiosResponse = await axios.get(
        `https://api.mcstatus.io/v2/status/java/${ip}${port ? ':' + port : ''}`
      );
      const result: MinecraftServerStatus = {
        online: res.data.online,
        version: res.data.version.name_clean,
        motd: res.data.motd.clean,
        players: {
          online: res.data.players.online,
          max: res.data.players.max,
          list: []
        }
      };
      for (const player of res.data.players.list as { name_clean: string }[]) {
        result.players.list.push(player.name_clean);
      }
      return result;
    } catch (e) {
      return {
        online: false,
        version: '',
        motd: '',
        players: {
          online: 0,
          max: 0,
          list: []
        }
      };
    }
  }

  public static async getMinecraftWiki(keyword: string): Promise<WikiResult> {
    try {
      const res: AxiosResponse = await axios.get(`https://zh.minecraft.wiki/w/?search=${keyword}`);
      const dom = new JSDOM(res.data);
      const document = dom.window.document;
      const content = document.getElementById('mw-content-text');
      const result: WikiResult = {
        success: !content?.getElementsByClassName('mw-search-nonefound').length || false,
        url: res.request.res.responseUrl || '',
        title: document.getElementById('firstHeading')?.textContent || '',
        desc: ''
      };
      for (let child of content?.getElementsByClassName('mw-parser-output').item(0)?.children || []) {
        if (child.id == 'toc') break;
        if (child.tagName != 'P') continue;
        if (!child.textContent) continue;
        if (child.textContent == '\n' || child.textContent == '\\n') continue;
        result.desc += '\r\n' + child.textContent.replace('\n', '').replace('\\n', '');
      }
      return result;
    } catch (_) {
      return {
        success: false,
        url: '',
        title: '',
        desc: ''
      };
    }
  }
}
