import React from 'react'

type Props = {
  color?: string
  width?: string
  height?: string
}

const ClaimIcon = ({ color = 'white', width = '40', height }: Props) => {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 28 31"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g>
        <path
          d="M9.46 8.47L10.91 9.76L12.14 8.50C12.30 8.34 12.61 8.34 12.77 8.50L14 9.73L15.20 8.50C15.37 8.34 15.67 8.34 15.83 8.50L17.06 9.76L18.51 8.47C18.65 8.36 18.81 8.34 18.98 8.42C19.14 8.47 19.25 8.64 19.25 8.80V21.93C19.25 22.12 19.14 22.25 18.98 22.34C18.81 22.42 18.65 22.39 18.51 22.25L17.06 21.00L15.83 22.25C15.67 22.42 15.37 22.42 15.20 22.25L14 21.02L12.77 22.25C12.61 22.42 12.30 22.42 12.14 22.25L10.91 21.00L9.46 22.28C9.32 22.39 9.16 22.42 9.00 22.34C8.83 22.25 8.75 22.12 8.75 21.93V8.80C8.75 8.64 8.83 8.47 9.00 8.42C9.16 8.34 9.32 8.36 9.46 8.47ZM9.62 20.97L10.64 20.07C10.80 19.93 11.07 19.93 11.24 20.09L12.47 21.33L13.67 20.09C13.84 19.93 14.14 19.93 14.30 20.09L15.53 21.33L16.73 20.09C16.90 19.93 17.17 19.93 17.34 20.07L18.38 20.97V9.79L17.34 10.66C17.17 10.83 16.90 10.83 16.73 10.66L15.53 9.43L14.30 10.66C14.14 10.83 13.84 10.83 13.67 10.66L12.47 9.43L11.24 10.66C11.07 10.83 10.80 10.83 10.64 10.66L9.62 9.79V20.97ZM11.38 12.30H16.62C16.84 12.30 17.06 12.52 17.06 12.74C17.06 12.99 16.84 13.18 16.62 13.18H11.38C11.13 13.18 10.94 12.99 10.94 12.74C10.94 12.52 11.13 12.30 11.38 12.30ZM10.94 17.99C10.94 17.77 11.13 17.55 11.38 17.55H16.62C16.84 17.55 17.06 17.77 17.06 17.99C17.06 18.24 16.84 18.43 16.62 18.43H11.38C11.13 18.43 10.94 18.24 10.94 17.99ZM11.38 14.93H16.62C16.84 14.93 17.06 15.15 17.06 15.36C17.06 15.61 16.84 15.80 16.62 15.80H11.38C11.13 15.80 10.94 15.61 10.94 15.36C10.94 15.15 11.13 14.93 11.38 14.93Z"
          fill={color}
        />
      </g>
      <defs>
        <filter
          id="filter0_d_143_328"
          x="0.75"
          y="0.336914"
          width="26.5"
          height="30.082"
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
          <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_143_328" />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="effect1_dropShadow_143_328"
            result="shape"
          />
        </filter>
      </defs>
    </svg>
  )
}

export default ClaimIcon
