import React from 'react'

type Props = {
    color?: string
    width?: string
    height?: string
}

const DashboardIcon = ({ color = 'white', width = '30', height = 'auto' }: Props) => {
    // Calculate height from width based on viewBox aspect ratio (24:25)
    const svgHeight = height === 'auto' ? String(Math.round(parseFloat(width) * 25 / 24)) : height
    return (
        <svg
            width={width}
            height={svgHeight}
            viewBox="0 0 24 25"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
        >
            <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M10.94 6.28C11.14 6.10 11.40 6.00 11.67 6C11.94 6.00 12.20 6.10 12.40 6.28L18.24 11.59C18.35 11.69 18.44 11.81 18.50 11.95C18.56 12.09 18.59 12.24 18.59 12.39V19.22H19.84C20.12 19.22 20.34 19.45 20.34 19.72C20.34 20.00 20.12 20.22 19.84 20.22H3.5C3.22 20.22 3 20.00 3 19.72C3 19.45 3.22 19.22 3.5 19.22H4.75V12.39C4.75 12.24 4.78 12.09 4.84 11.95C4.90 11.81 4.99 11.69 5.11 11.59L10.94 6.28ZM17.59 12.39V19.22H13.92V15.05C13.92 14.78 13.70 14.55 13.42 14.55H9.92C9.64 14.55 9.42 14.78 9.42 15.05V19.22H5.75V12.39C5.75 12.38 5.75 12.37 5.76 12.36C5.76 12.35 5.77 12.34 5.78 12.33L11.62 7.02C11.63 7.01 11.65 7 11.67 7C11.69 7 11.71 7.01 11.73 7.02L17.57 12.33C17.57 12.34 17.58 12.35 17.59 12.36C17.59 12.37 17.59 12.38 17.59 12.39ZM10.42 19.22V15.55H12.92V19.22H10.42Z"
                fill={"transparent"}
            />
        </svg>
    )
}

export default DashboardIcon
