import { RefreshButton } from "./RefreshButton";
import { Select } from "../ui/select";
import { Label } from "../ui/label";
import { useT } from "../hooks/useT";
import { C } from "../i18n-common";
import type { LocalizedString } from "../../../metadata/dataTypes";

// 渠道节点面板里的「账号」块：标签、刷新按钮、loading/error/空 三态、下拉框，全在这一个组件里。
//
// 为什么是组件而不是一段可以照抄的样板：这块 UI 此前在七个面板里各手写一遍，标签自然就漂了——
// 五个写 Account / 账号，两个写 Target Account / 目标账号。文案分散在使用处时，
// 「保持一致」只能靠人每次重新记住一遍，而这件事已经失败过了。现在标签只存在于下面那一行，
// 调用方连表达「换个说法」的语法都没有。
//
// ── 关于 Target Account 那个说法（有人会想把它改回去，先读这段） ──────────────────
// 底下确实有一层真实的语义差别：内容域 action（xContentAction / tiktokContentAction）里，
// 这个选择器选的是「执行这个动作的账号」，它可以与「触发本流程的那个渠道」不是同一个——
// flow/src/index.ts 里 xContentAction 的注释记着这笔账：配置了 channelId 就一定压过触发渠道，
// 正是因为「YouTube 触发 + X 动作」曾经必然失败。所以 Target Account 不是笔误。
//
// 但用户看过两个方案（其一：给所有 action 换成「执行账号」这类措辞，让区分变成有规则的；
// 其二：全站统一成 Account / 账号），拍板选了后者：这个区别在编辑器里没有可操作后果——
// 用户在两种面板里做的事都是「挑一个已绑定的账号」，多一个词只会让人以为还有个别处的
// 「非目标账号」。区别继续存在于引擎与文档里，只是不在标签上表达。
// 这是有意的决定，不是漏改；要改回去请先推翻这个决定，别当成 bug 修。
// ──────────────────────────────────────────────────────────────────────

export interface ChannelAccountOption {
  id: string;
  username: string;
}

interface ChannelAccountFieldBaseProps {
  /** 当前选中的渠道 id（节点的 data.channelId）。 */
  value: string;
}

/**
 * 只读模式：账号不是在这里挑出来的，而是由「已连接哪个账号」决定的
 * （YouTube / GitHub 内容触发器就是这样）。仍然渲染成同一个标签 + 同一个下拉框外观，
 * 免得同一块 UI 在不同面板里长得不一样。
 */
export interface ReadOnlyChannelAccountFieldProps extends ChannelAccountFieldBaseProps {
  readOnly: true;
  /** 已本地化的展示文案，如 `@octocat` 或账号邮箱。 */
  displayText: string;
}

/** 可选模式：在已绑定的账号里挑一个。 */
export interface PickerChannelAccountFieldProps extends ChannelAccountFieldBaseProps {
  readOnly?: false;
  onChange: (channelId: string) => void;
  /**
   * 已绑定账号列表。null = 还没拿到（配合 loading / error）——
   * 取数在途与取数失败都不许冒充「空列表」，见 useRefreshableList 的三态说明。
   * null 且既不 loading 也不 error（useRefreshableList 的 enabled:false）时本组件什么都不渲染：
   * 那是「还没取过」，不是「一个都没有」。
   */
  options: ChannelAccountOption[] | null;
  loading: boolean;
  error: boolean;
  /** 用户显式刷新。省略则不渲染刷新按钮（列表来源不会在别处被改动时）。 */
  onRefresh?: () => void;
  /**
   * 「一个账号都没绑」时的文案。各渠道措辞不同（"No X accounts linked" /
   * "No TikTok accounts linked"），所以由调用方给；其余三态的文案全站一致，收在本组件里。
   */
  emptyText: LocalizedString;
}

export type ChannelAccountFieldProps =
  | ReadOnlyChannelAccountFieldProps
  | PickerChannelAccountFieldProps;

// 取不到 ≠ 没绑定账号。前者要用户重试，后者要用户去绑定；渲染成同一屏就会让一个早就
// 绑好账号的用户再去绑一次。
const ACCOUNT_LIST_LOAD_ERROR: LocalizedString = {
  en: "Could not load your linked accounts. Try again later.",
  zh: "无法获取已绑定账号，请稍后重试。",
};

export function ChannelAccountField(props: ChannelAccountFieldProps) {
  const T = useT();
  // 全站唯一一处账号标签。改这里就是七个面板一起改，也没有别的地方可以改。
  const label = T({ en: "Account", zh: "账号" });

  if (props.readOnly) {
    return (
      <div>
        <Label className="text-xs block mb-1">{label}</Label>
        <Select value={props.value} disabled className="w-full text-sm">
          <option value={props.value}>{props.displayText}</option>
        </Select>
      </div>
    );
  }

  const { value, onChange, options, loading, error, onRefresh, emptyText } = props;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <Label className="text-xs">{label}</Label>
        {onRefresh && (
          <RefreshButton
            onClick={onRefresh}
            busy={loading}
            tooltip={T({ en: "Reload linked accounts", zh: "重新加载已绑定账号" })}
          />
        )}
      </div>
      {/* 三态一个都不许压平：refresh 会把 data 清成 null，少了 loading 分支就会在刷新的
          一瞬间闪出「尚未绑定」并让当前已选账号从下拉框里消失；少了 error 分支，一次 502
          会被渲染成「去绑定账号」，而用户早就绑好了、真正该做的是重试。 */}
      {loading ? (
        <p className="text-xs text-muted-foreground">{T(C.loading)}</p>
      ) : error ? (
        <p className="text-xs text-destructive italic">{T(ACCOUNT_LIST_LOAD_ERROR)}</p>
      ) : options === null ? (
        // 既不在途、也没失败、还没有数据 —— 就是「压根没取过」（useRefreshableList 的
        // enabled:false 正是这个状态）。什么都不知道就什么都不说：这里如果落到下面的
        // emptyText，就又一次把「未知」渲染成了「空」，与 loading/error 两条同一个错误。
        null
      ) : options.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">{T(emptyText)}</p>
      ) : (
        <Select
          value={value}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
          className="w-full text-sm"
        >
          <option value="">{T({ en: "Select account...", zh: "选择账号…" })}</option>
          {options.map((ch) => (
            <option key={ch.id} value={ch.id}>@{ch.username}</option>
          ))}
        </Select>
      )}
    </div>
  );
}
