import logo from '../assets/logo.png'

export function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <img
      src={logo}
      width={size}
      height={size}
      alt="Vroomk"
      className="brand-mark"
      draggable={false}
    />
  )
}
