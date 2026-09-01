import React from 'react'

type Props = {
  color?: string
  width?: string
  height?: string
}

const BidIcon = ({ color = 'white', width = '40', height = 'auto' }: Props) => {
  // Calculate height from width based on viewBox aspect ratio (31:32)
  const svgHeight = height === 'auto' ? String(Math.round(parseFloat(width) * 32 / 31)) : height
  return (
    <svg
      width={width}
      height={svgHeight}
      viewBox="0 0 31 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g >
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M18.86 10.11C19.42 10.37 19.94 10.74 20.4 11.2C20.4 11.2 20.41 11.21 20.41 11.21C20.41 11.21 20.41 11.22 20.42 11.22C20.86 11.67 21.22 12.17 21.49 12.71C22.2 14.16 22.24 15.85 21.63 17.32L21.64 17.33C21.36 17.99 20.96 18.61 20.42 19.15L18.89 20.71C18.77 20.78 18.67 20.89 18.58 21C18.46 21.14 18.34 21.27 18.16 21.32C17.72 21.58 17.19 21.73 16.67 21.73H16.61C15.85 21.73 15.14 21.44 14.62 20.91L14.61 20.9C14.61 20.9 14.6 20.9 14.6 20.89L14.31 20.63C14.3 20.62 14.29 20.62 14.29 20.61C13.52 19.84 12.28 19.9 11.55 20.72L9.88 22.65L8.97 21.73L10.9 20.06C11.71 19.33 11.78 18.08 11 17.32C10.99 17.32 10.99 17.31 10.98 17.31L10.72 17.02C10.72 17.01 10.71 17.01 10.71 17L10.7 17C10.18 16.47 9.88 15.77 9.88 15.01V14.95C9.88 14.42 10.03 13.89 10.29 13.45C10.34 13.27 10.48 13.15 10.62 13.03C10.72 12.94 10.83 12.85 10.91 12.72L12.46 11.2C13 10.66 13.62 10.25 14.29 9.98L14.3 9.99C15.75 9.38 17.42 9.42 18.86 10.11ZM21.15 10.6C21.13 10.58 21.11 10.56 21.09 10.54C20.44 9.9 19.69 9.41 18.89 9.09C16.52 8.14 13.72 8.62 11.79 10.52L10.03 12.28C9.35 12.96 8.97 13.89 8.95 14.86C8.94 14.89 8.94 14.93 8.94 14.97V15.02C8.94 15.64 9.1 16.25 9.38 16.79C9.55 17.11 9.77 17.41 10.03 17.67L10.32 17.96C10.7 18.34 10.67 18.96 10.26 19.34L8.33 21.01C8.14 21.17 8.03 21.38 8.01 21.62C8.01 21.65 8 21.67 8 21.7C8 21.74 8 21.78 8.01 21.81C8.02 22.03 8.13 22.24 8.27 22.38L9.21 23.32C9.21 23.32 9.22 23.33 9.22 23.33L9.23 23.34C9.38 23.49 9.58 23.59 9.8 23.61C9.84 23.61 9.88 23.61 9.91 23.61C9.94 23.61 9.97 23.61 9.99 23.6C10.23 23.59 10.44 23.47 10.61 23.28L12.28 21.35C12.65 20.94 13.26 20.91 13.64 21.28L13.92 21.56C13.93 21.57 13.94 21.58 13.94 21.58L13.94 21.58C14.2 21.84 14.49 22.05 14.8 22.22C15.35 22.52 15.96 22.68 16.59 22.68H16.65C16.68 22.68 16.72 22.67 16.76 22.67C17.72 22.64 18.65 22.27 19.33 21.58L21.09 19.83C23.03 17.87 23.49 15.01 22.48 12.62C22.18 11.89 21.73 11.21 21.15 10.6Z"
          fill={color}
        />
      </g>
      <defs>
        <filter
          id="filter0_d_143_698"
          x="0"
          y="0.61"
          width="31"
          height="31"
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
          <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_143_698" />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="effect1_dropShadow_143_698"
            result="shape"
          />
        </filter>
      </defs>
    </svg>
  )
}

export default BidIcon
