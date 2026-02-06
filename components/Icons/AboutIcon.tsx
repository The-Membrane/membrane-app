import React from 'react'

type Props = {
  color?: string
  width?: string
  height?: string
}

const AboutIcon = ({ color = 'white', width = '30', height = 'auto' }: Props) => {
  // Calculate height from width based on viewBox aspect ratio (24:24 = 1:1)
  const svgHeight = height === 'auto' ? width : height
  return (
    <svg
      width={width}
      height={svgHeight}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"
        fill={color}
      />
    </svg>
  )
}

export default AboutIcon

