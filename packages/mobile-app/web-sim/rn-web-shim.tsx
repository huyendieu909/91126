import React from 'react';

type AnyStyle = Record<string, unknown> | false | null | undefined | AnyStyle[];

function flattenStyle(input?: AnyStyle): React.CSSProperties {
  if (!input) return {};
  const merged: Record<string, unknown> = {};

  const visit = (item: AnyStyle) => {
    if (!item) return;
    if (Array.isArray(item)) {
      for (const sub of item) visit(sub);
      return;
    }
    Object.assign(merged, item);
  };
  visit(input);

  const css: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null) continue;
    switch (k) {
      case 'paddingHorizontal':
        css.paddingLeft = v;
        css.paddingRight = v;
        break;
      case 'paddingVertical':
        css.paddingTop = v;
        css.paddingBottom = v;
        break;
      case 'marginHorizontal':
        css.marginLeft = v;
        css.marginRight = v;
        break;
      case 'marginVertical':
        css.marginTop = v;
        css.marginBottom = v;
        break;
      case 'borderWidth':
        css.borderWidth = v;
        css.borderStyle = 'solid';
        break;
      case 'borderBottomWidth':
        css.borderBottomWidth = v;
        css.borderBottomStyle = 'solid';
        break;
      case 'flex':
        css.flex = typeof v === 'number' ? `${v} ${v} 0%` : v;
        break;
      default:
        css[k] = v;
    }
  }
  return css as React.CSSProperties;
}

export const StatusBar = {
  currentHeight: 28,
};

export const Platform = {
  OS: 'web' as const,
  select<T>(specifics: { web?: T; android?: T; default?: T }): T | undefined {
    return specifics.web ?? specifics.default ?? specifics.android;
  },
};

export const StyleSheet = {
  create<T extends Record<string, Record<string, unknown>>>(styles: T): T {
    return styles;
  },
};

export const AppState = {
  currentState: 'active',
  addEventListener(_type: 'change', handler: (state: string) => void) {
    const listener = () => {
      handler(document.visibilityState === 'visible' ? 'active' : 'background');
    };
    document.addEventListener('visibilitychange', listener);
    return {
      remove() {
        document.removeEventListener('visibilitychange', listener);
      },
    };
  },
};

export const Linking = {
  async openURL(url: string): Promise<void> {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
};

export const View: React.FC<{
  style?: AnyStyle;
  children?: React.ReactNode;
}> = ({ style, children }) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      boxSizing: 'border-box',
      minWidth: 0,
      minHeight: 0,
      ...flattenStyle(style),
    }}
  >
    {children}
  </div>
);

export const SafeAreaView: React.FC<{
  style?: AnyStyle;
  children?: React.ReactNode;
}> = ({ style, children }) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      boxSizing: 'border-box',
      height: '100%',
      minHeight: 0,
      overflow: 'hidden',
      ...flattenStyle(style),
    }}
  >
    {children}
  </div>
);

export const Text: React.FC<{
  style?: AnyStyle;
  numberOfLines?: number;
  children?: React.ReactNode;
}> = ({ style, numberOfLines, children }) => {
  const clampStyles: React.CSSProperties =
    numberOfLines && numberOfLines > 0
      ? {
          display: '-webkit-box',
          WebkitLineClamp: numberOfLines,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          wordBreak: 'break-all',
        }
      : {};
  return (
    <span
      style={{
        fontFamily:
          'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        lineHeight: 1.4,
        ...clampStyles,
        ...flattenStyle(style),
      }}
    >
      {children}
    </span>
  );
};

export const TouchableOpacity: React.FC<{
  style?: AnyStyle;
  disabled?: boolean;
  onPress?: () => void;
  children?: React.ReactNode;
}> = ({ style, disabled, onPress, children }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={() => {
      if (!disabled && onPress) onPress();
    }}
    style={{
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      boxSizing: 'border-box',
      border: 'none',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      transition: 'transform 0.1s ease, opacity 0.15s ease',
      ...flattenStyle(style),
    }}
  >
    {children}
  </button>
);

export const TextInput: React.FC<{
  style?: AnyStyle;
  value?: string;
  onChangeText?: (text: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  placeholderTextColor?: string;
  secureTextEntry?: boolean;
}> = ({
  style,
  value,
  onChangeText,
  onBlur,
  placeholder,
  secureTextEntry,
}) => (
  <input
    type={secureTextEntry ? 'password' : 'text'}
    value={value ?? ''}
    onChange={(e) => onChangeText?.(e.target.value)}
    onBlur={onBlur}
    placeholder={placeholder}
    style={{
      width: '100%',
      boxSizing: 'border-box',
      outline: 'none',
      fontFamily: 'inherit',
      ...flattenStyle(style),
    }}
  />
);

export const Switch: React.FC<{
  value?: boolean;
  onValueChange?: (val: boolean) => void;
}> = ({ value, onValueChange }) => (
  <input
    type="checkbox"
    checked={Boolean(value)}
    onChange={(e) => onValueChange?.(e.target.checked)}
    style={{
      width: 18,
      height: 18,
      accentColor: '#6366f1',
      cursor: 'pointer',
    }}
  />
);

export const ScrollView: React.FC<{
  style?: AnyStyle;
  contentContainerStyle?: AnyStyle;
  children?: React.ReactNode;
}> = ({ style, contentContainerStyle, children }) => (
  <div
    style={{
      overflowY: 'auto',
      maxHeight: '100%',
      boxSizing: 'border-box',
      ...flattenStyle(style),
    }}
  >
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        ...flattenStyle(contentContainerStyle),
      }}
    >
      {children}
    </div>
  </div>
);

export function FlatList<T>({
  data,
  keyExtractor,
  renderItem,
  ListEmptyComponent,
}: {
  data: T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (info: { item: T; index: number }) => React.ReactNode;
  ListEmptyComponent?: React.ReactNode;
}) {
  return (
    <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
      {data.length === 0
        ? ListEmptyComponent ?? null
        : data.map((item, index) => (
            <React.Fragment key={keyExtractor(item, index)}>
              {renderItem({ item, index })}
            </React.Fragment>
          ))}
    </div>
  );
}

export const Modal: React.FC<{
  visible?: boolean;
  transparent?: boolean;
  animationType?: string;
  children?: React.ReactNode;
}> = ({ visible, children }) => {
  if (!visible) return null;
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {children}
    </div>
  );
};

export const ActivityIndicator: React.FC<{
  color?: string;
  size?: 'small' | 'large' | number;
}> = ({ color = '#6366f1', size = 'small' }) => {
  const px = size === 'large' ? 32 : typeof size === 'number' ? size : 18;
  return (
    <div
      style={{
        width: px,
        height: px,
        borderRadius: '50%',
        border: `3px solid rgba(99,102,241,0.2)`,
        borderTopColor: color,
        animation: 'rnSpin 0.8s linear infinite',
      }}
    />
  );
};
