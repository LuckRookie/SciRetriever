/** The parts of the extension API the popup uses (Chrome and Edge, Manifest V3). */
declare namespace chrome {
  namespace storage {
    const local: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string[]): Promise<void>;
    };
  }
  namespace permissions {
    function request(permissions: { origins: string[] }): Promise<boolean>;
    function contains(permissions: { origins: string[] }): Promise<boolean>;
  }
  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
    }
    function query(query: {
      active: boolean;
      currentWindow: boolean;
    }): Promise<Tab[]>;
  }
  namespace scripting {
    function executeScript<T>(injection: {
      target: { tabId: number };
      func: () => T;
    }): Promise<{ result?: T }[]>;
  }
}
