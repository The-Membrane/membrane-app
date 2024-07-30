import React from 'react'

type Props = {
  color?: string
  width?: string
  height?: string
}

const EarnIcon = ({ color = 'white', width = '40', height = 'auto' }: Props) => {
  return (<svg 
    width={width}
    height={height} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" xmlnsXlink="http://www.w3.org/1999/xlink">
    <rect width="32" height="32" fill="url(#pattern0_887_201)" filter="url(#filter0_d_143_698)"/>
    <defs>
      <filter
          id="filter0_d_143_698"
          x="0"
          y="0.614258"
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
    <pattern id="pattern0_887_201" patternContentUnits="objectBoundingBox" width="1" height="1">
    <use xlinkHref="#image0_887_201" transform="scale(0.00125)"/>
    </pattern>
    <image id="image0_887_201" width="800" height="800" xlinkHref="/public/images/EarnIcon.svg"/>
    </defs>
    </svg>    
  )
}

export default EarnIcon
