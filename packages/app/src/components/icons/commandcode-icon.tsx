import Svg, { Path } from "react-native-svg";

interface CommandCodeIconProps {
  size?: number;
  color?: string;
}

export function CommandCodeIcon({ size = 16, color = "currentColor" }: CommandCodeIconProps) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M8 9l-3 3 3 3" />
      <Path d="M13 15l3-3-3-3" />
      <Path d="M3 4h18v16H3z" />
    </Svg>
  );
}
