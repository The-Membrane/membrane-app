import React from 'react'

type Props = {
  color?: string
}

const WalletIcon = ({ color = 'white' }: Props) => {
  return (
    <svg
      width="40"
      height="auto"
      viewBox="0 0 30 29"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g filter="url(#filter0_d_143_59)">
        <path
          d="M10.1875 8.23926H20.6875C20.9062 8.23926 21.125 8.45801 21.125 8.67676C21.125 8.92285 20.9062 9.11426 20.6875 9.11426H10.1875C9.44922 9.11426 8.875 9.71582 8.875 10.4268V18.3018C8.875 19.04 9.44922 19.6143 10.1875 19.6143H19.8125C20.5234 19.6143 21.125 19.04 21.125 18.3018V12.1768C21.125 11.4658 20.5234 10.8643 19.8125 10.8643H11.0625C10.8164 10.8643 10.625 10.6729 10.625 10.4268C10.625 10.208 10.8164 9.98926 11.0625 9.98926H19.8125C21.0156 9.98926 22 10.9736 22 12.1768V18.3018C22 19.5322 21.0156 20.4893 19.8125 20.4893H10.1875C8.95703 20.4893 8 19.5322 8 18.3018V10.4268C8 9.22363 8.95703 8.23926 10.1875 8.23926ZM18.5 15.8955C18.1172 15.8955 17.8438 15.6221 17.8438 15.2393C17.8438 14.8838 18.1172 14.583 18.5 14.583C18.8555 14.583 19.1562 14.8838 19.1562 15.2393C19.1562 15.6221 18.8555 15.8955 18.5 15.8955Z"
          fill={color}
        />
      </g>
      <defs>
        <filter
          id="filter0_d_143_59"
          x="0"
          y="0.239258"
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
