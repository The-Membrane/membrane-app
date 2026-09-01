import React from 'react'

type Props = {
    color?: string
    width?: string
    height?: string
}

const NFTAuctionIcon = ({ color = 'white', width = '40', height }: Props) => {
    return (
        <svg
            width={width}
            height={height}
            viewBox="0 0 24 25" 
            fill="none" 
            xmlns="http://www.w3.org/2000/svg"
            >
            <g>
                <path 
                    d="M13.56 5.56C13.8 5.83 13.8 6.24 13.56 6.49L17.88 10.81C18.13 10.56 18.54 10.56 18.81 10.81C19.05 11.08 19.05 11.49 18.81 11.74L18.34 12.2L15.75 14.8L15.31 15.24C15.04 15.51 14.63 15.51 14.38 15.24C14.13 14.99 14.11 14.61 14.35 14.36L10.03 10.01C9.76 10.26 9.38 10.23 9.13 9.99C8.86 9.74 8.86 9.33 9.13 9.08L9.57 8.65L12.16 6.02L12.63 5.56C12.88 5.31 13.29 5.31 13.53 5.56H13.56ZM12.63 7.42L10.93 9.08L15.28 13.43L16.95 11.74L12.63 7.42ZM11.1 12.34L12.03 13.27L10.66 14.63L10.85 14.83C11.21 15.15 11.21 15.73 10.85 16.06L7.79 19.12C7.46 19.47 6.89 19.47 6.56 19.12L5.25 17.81C4.89 17.48 4.89 16.9 5.25 16.58L8.31 13.51C8.64 13.16 9.21 13.16 9.54 13.51L9.73 13.7L11.1 12.34ZM8.94 14.74L6.48 17.18L7.19 17.89L9.62 15.43L8.94 14.74Z"
                    fill={color}
                />
            </g>
      <defs>
        <filter
          id="filter0_d_143_651"
          x="0"
          y="0.82"
          width="30.55"
          height="30.55"
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
          <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_143_651" />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="effect1_dropShadow_143_651"
            result="shape"
          />
        </filter>
      </defs>
    </svg>
    )
}

export default NFTAuctionIcon