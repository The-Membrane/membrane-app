import React from 'react'

type Props = {
  color?: string
  width?: string
}

const WalletIcon = ({ color = 'white', width = '40' }: Props) => {
  // Calculate height from width based on viewBox aspect ratio (30:29)
  const svgHeight = String(Math.round(parseFloat(width) * 29 / 30))
  return (
    <svg
      width={width}
      height={svgHeight}
      viewBox="0 0 30 29"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g>
        <path
          d="M10.19 8.24H20.69C20.91 8.24 21.13 8.46 21.13 8.68C21.13 8.92 20.91 9.11 20.69 9.11H10.19C9.45 9.11 8.88 9.72 8.88 10.43V18.3C8.88 19.04 9.45 19.61 10.19 19.61H19.81C20.52 19.61 21.13 19.04 21.13 18.3V12.18C21.13 11.47 20.52 10.86 19.81 10.86H11.06C10.82 10.86 10.63 10.67 10.63 10.43C10.63 10.21 10.82 9.99 11.06 9.99H19.81C21.02 9.99 22 10.97 22 12.18V18.3C22 19.53 21.02 20.49 19.81 20.49H10.19C8.96 20.49 8 19.53 8 18.3V10.43C8 9.22 8.96 8.24 10.19 8.24ZM18.5 15.9C18.12 15.9 17.84 15.62 17.84 15.24C17.84 14.88 18.12 14.58 18.5 14.58C18.86 14.58 19.16 14.88 19.16 15.24C19.16 15.62 18.86 15.9 18.5 15.9Z"
          fill={color}
        />
      </g>
      <defs>
        <filter
          id="filter0_d_143_59"
          x="0"
          y="0.24"
          width="30"
          height="28.25"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset />
          <feGaussianBlur stdDeviation="4" />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.64 0" />
          <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_143_59" />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="effect1_dropShadow_143_59"
            result="shape"
          />
        </filter>
      </defs>
    </svg>
  )
}

export default WalletIcon
