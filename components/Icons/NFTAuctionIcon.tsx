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
            <g filter="url(#filter0_d_143_651)">
                <path 
                    d="M13.5586 5.55566C13.8047 5.8291 13.8047 6.23926 13.5586 6.48535L17.8789 10.8057C18.125 10.5596 18.5352 10.5596 18.8086 10.8057C19.0547 11.0791 19.0547 11.4893 18.8086 11.7354L18.3438 12.2002L15.7461 14.7979L15.3086 15.2354C15.0352 15.5088 14.625 15.5088 14.3789 15.2354C14.1328 14.9893 14.1055 14.6064 14.3516 14.3604L10.0312 10.0127C9.75781 10.2588 9.375 10.2314 9.12891 9.98535C8.85547 9.73926 8.85547 9.3291 9.12891 9.08301L9.56641 8.64551L12.1641 6.02051L12.6289 5.55566C12.875 5.30957 13.2852 5.30957 13.5312 5.55566H13.5586ZM12.6289 7.41504L10.9336 9.08301L15.2812 13.4307L16.9492 11.7354L12.6289 7.41504ZM11.0977 12.3369L12.0273 13.2666L10.6602 14.6338L10.8516 14.8252C11.207 15.1533 11.207 15.7275 10.8516 16.0557L7.78906 19.1182C7.46094 19.4736 6.88672 19.4736 6.55859 19.1182L5.24609 17.8057C4.89062 17.4775 4.89062 16.9033 5.24609 16.5752L8.30859 13.5127C8.63672 13.1572 9.21094 13.1572 9.53906 13.5127L9.73047 13.7041L11.0977 12.3369ZM8.9375 14.7432L6.47656 17.1768L7.1875 17.8877L9.62109 15.4268L8.9375 14.7432Z"
                    fill={color}
                />
            </g>
      <defs>
        <filter
          id="filter0_d_143_651"
          x="0"
          y="0.817383"
          width="30.5469"
          height="30.5469"
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