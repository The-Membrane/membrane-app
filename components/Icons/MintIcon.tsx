import React from 'react'

type Props = {
  color?: string
  width?: string
  height?: string
}

const MintIcon = ({ color = 'white', width = '40', height }: Props) => {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 31 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g filter="url(#filter0_d_143_651)">
        <path
          d="M20.9609 18.1689C21.3984 16.0361 20.7422 13.7393 19.1836 12.1533C17.625 10.5947 15.3281 9.96582 13.1953 10.4033C14.8906 11.2236 16.4219 12.3994 17.707 13.6572C18.9922 14.9424 20.1406 16.501 20.9609 18.1689ZM11.7734 10.7314C11.418 10.5947 11.3906 10.0752 11.7734 9.91113C14.4805 8.81738 17.707 9.47363 19.8125 11.5518C21.8906 13.6299 22.5469 16.8564 21.4531 19.5908C21.2891 19.9736 20.7695 19.9463 20.6328 19.5908C19.8672 17.6221 18.582 15.7627 17.0781 14.2861C15.6016 12.8096 13.7422 11.4697 11.7734 10.7314ZM8.27344 21.6416L15.4102 13.958C15.6289 14.1221 15.875 14.3135 16.0938 14.5322L8.90234 22.2432C8.875 22.2705 8.875 22.2979 8.875 22.3525C8.875 22.4346 8.92969 22.4893 9.01172 22.4893C9.06641 22.4893 9.09375 22.4893 9.12109 22.4619L16.832 15.2705C17.0508 15.4893 17.2422 15.7354 17.4062 15.9541L9.72266 23.0908C9.53125 23.2822 9.28516 23.3643 9.01172 23.3643C8.4375 23.3643 8 22.9268 8 22.3525C8 22.0791 8.08203 21.833 8.27344 21.6416ZM20.1133 9.93848L21.4258 11.251C21.5898 11.415 21.5898 11.7158 21.4258 11.8799C21.2617 12.0439 20.9609 12.0439 20.7969 11.8799L19.4844 10.5674C19.3203 10.4033 19.3203 10.1025 19.4844 9.93848C19.6484 9.77441 19.9492 9.77441 20.1133 9.93848Z"
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

export default MintIcon
