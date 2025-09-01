import React, { useCallback, useMemo, useState } from 'react'
import { Box, Button, Flex, Grid, GridItem, HStack, Input, NumberInput, NumberInputField, Text, VStack } from '@chakra-ui/react'
import { useAddTrack, } from '@/components/Racing/hooks'
import ConfirmModal from '../ConfirmModal'
import ToolPanel from './components/ToolPanel'
import { TrackTemplate } from './types/trackTemplates'

type TileType = 'empty' | 'wall' | 'start' | 'finish' | 'sticky' | 'boost'

type TileProperties = {
  speed_modifier: number
  blocks_movement: boolean
  skip_next_turn: boolean
  damage: number
  is_finish: boolean
  is_start: boolean
}

const defaultTile = (): TileProperties => ({
  speed_modifier: 1,
  blocks_movement: false,
  skip_next_turn: false,
  damage: 0,
  is_finish: false,
  is_start: false,
})

const palette: { key: TileType; label: string; color: string }[] = [
  { key: 'empty', label: 'Empty', color: '#111111' },
  { key: 'wall', label: 'Wall', color: '#0033ff' },
  { key: 'start', label: 'Start', color: 'red' },
  { key: 'finish', label: 'Finish', color: '#00ff00' },
  { key: 'sticky', label: 'Sticky', color: '#555555' },
  { key: 'boost', label: 'Boost', color: '#ffdd00' },
]

function applyTypeToTile(tileType: TileType): TileProperties {
  switch (tileType) {
    case 'empty':
      return defaultTile()
    case 'wall':
      return { ...defaultTile(), blocks_movement: true }
    case 'start':
      return { ...defaultTile(), is_start: true }
    case 'finish':
      return { ...defaultTile(), is_finish: true }
    case 'sticky':
      return { ...defaultTile(), skip_next_turn: true }
    case 'boost':
      return { ...defaultTile(), speed_modifier: 3 }
    default:
      return defaultTile()
  }
}

function createLayout(width: number | undefined, height: number | undefined): TileProperties[][] {
  if (width === undefined || height === undefined) return []
  return Array.from({ length: height }, () => Array.from({ length: width }, () => defaultTile()))
}

function resizeLayout(layout: TileProperties[][], width: number, height: number): TileProperties[][] {
  const oldH = layout.length
  const oldW = layout[0]?.length ?? 0
  const newRows: TileProperties[][] = []
  for (let y = 0; y < height; y++) {
    if (y < oldH) {
      const row = layout[y]
      const newRow = row.slice(0, width)
      while (newRow.length < width) newRow.push(defaultTile())
      newRows.push(newRow)
    } else {
      newRows.push(Array.from({ length: width }, () => defaultTile()))
    }
  }
  return newRows
}

const MAX = 50

const TrackCreator: React.FC = () => {
  const [name, setName] = useState('')
  const [width, setWidth] = useState<number | undefined>(20)
  const [height, setHeight] = useState<number | undefined>(20)
  const [selected, setSelected] = useState<TileType>('wall')
  const [isMouseDown, setIsMouseDown] = useState(false)
  const [isAddTrackFocused, setIsAddTrackFocused] = useState(false)



  const [layout, setLayout] = useState<TileProperties[][]>(() => createLayout(width, height))

  const selectedLabel = useMemo(() => palette.find(p => p.key === selected)?.label ?? 'Empty', [selected])

  const onResize = useCallback((w: number, h: number) => {
    const boundedW = Math.max(1, Math.min(MAX, Math.floor(w)))
    const boundedH = Math.max(1, Math.min(MAX, Math.floor(h)))
    setWidth(boundedW)
    setHeight(boundedH)
    // console.log("onResize", boundedW, boundedH)
    setLayout(prev => resizeLayout(prev, boundedW, boundedH))
  }, [])

  const paintAt = useCallback((x: number, y: number) => {
    setLayout(prev => {
      if (y < 0 || y >= prev.length || x < 0 || x >= prev[0].length) return prev
      const next = prev.map(row => row.slice())
      next[y][x] = applyTypeToTile(selected)
      return next
    })
  }, [selected])

  const reset = () => setLayout(createLayout(width, height))

  // Template and component handlers
  const handleTemplateSelect = (template: TrackTemplate) => {
    setLayout(template.layout)
    setWidth(template.width)
    setHeight(template.height)
  }



  const handleLayoutChange = (newLayout: TileProperties[][]) => {
    setLayout(newLayout)
  }

  const addTrackTx = useAddTrack({ name, width, height, layout })



  // Requirements derived state
  const hasTitle = name.trim().length > 0
  const numStartTiles = useMemo(() => layout.reduce((sum, row) => sum + row.filter(t => t.is_start).length, 0), [layout])
  const numFinishTiles = useMemo(() => layout.reduce((sum, row) => sum + row.filter(t => t.is_finish).length, 0), [layout])
  const hasStart = numStartTiles > 0
  const hasFinish = numFinishTiles > 0

  // Check if any requirements are missing
  const hasMissingRequirements = !hasTitle || !hasStart || !hasFinish


  // Determine text color for requirement highlighting
  const getRequirementColor = (requirementMet: boolean) => {
    if (!isAddTrackFocused || !hasMissingRequirements) {
      return requirementMet ? '#e6e6e6' : '#666666'
    }
    return requirementMet ? '#e6e6e6' : '#ff0000'
  }

  const cellSize = window.innerWidth < 768 ? 12 : 16
  const gridColumns = layout[0]?.length ?? 0
  const gridTemplate = `repeat(${gridColumns}, ${cellSize}px)`

  const onWidthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault()
    const value = e.target.value
    if (value === '') {
      setWidth(undefined)
    } else {
      const nextW = Number(value)
      if (height === undefined) {
        setWidth(nextW)
      } else {
        onResize(nextW, height)
      }
    }
  }

  const onHeightChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault()
    const value = e.target.value
    if (value === '') {
      setHeight(undefined)
    } else {
      const nextH = Number(value)
      if (width === undefined) {
        setHeight(nextH)
      } else {
        onResize(width, nextH)
      }
    }
  }

  return (
    <Flex w="100%" h="100vh" bg="#0b0e17" color="#e6e6e6" overflow="hidden" direction={{ base: 'column', lg: 'row' }}>
      <VStack w={{ base: '100%', lg: '240px' }} p={{ base: 2, lg: 4 }} spacing={{ base: 2, lg: 4 }} align="stretch" borderRight={{ base: 'none', lg: '1px solid #1d2333' }} borderBottom={{ base: '1px solid #1d2333', lg: 'none' }} bg="#0f1422" h={{ base: 'auto', lg: '100vh' }} maxH={{ base: '50vh', lg: '100vh' }} overflow="hidden">
        <Text fontSize={{ base: 'md', lg: 'lg' }} fontWeight="bold">Tools</Text>

        {/* Scrollable Tools Section */}
        <Box
          flex="1"
          overflowY="auto"
          pr={2}
          sx={{
            '&::-webkit-scrollbar': {
              width: '6px',
            },
            '&::-webkit-scrollbar-track': {
              background: '#0f1422',
            },
            '&::-webkit-scrollbar-thumb': {
              background: '#2a3550',
              borderRadius: '3px',
            },
            '&::-webkit-scrollbar-thumb:hover': {
              background: '#3a4560',
            },
          }}
        >
          <VStack align="stretch" spacing={4}>
            <VStack align="stretch" spacing={{ base: 1, lg: 2 }}>
              {palette.map((p) => (
                <HStack key={p.key} spacing={{ base: 2, lg: 3 }} onClick={() => setSelected(p.key)} cursor="pointer" p={{ base: 1, lg: 2 }} borderRadius={6} bg={selected === p.key ? '#1d2540' : 'transparent'} _hover={{ bg: '#161c2e' }} minH={{ base: '44px', lg: 'auto' }}>
                  <Box w={{ base: '16px', lg: '18px' }} h={{ base: '16px', lg: '18px' }} borderRadius={3} bg={p.color} border="1px solid #2a3550" />
                  <Text fontSize={{ base: 'xs', lg: 'sm' }}>{p.label}</Text>
                </HStack>
              ))}
            </VStack>

            <Box h="1px" bg="#1d2333" />
            <Text fontSize={{ base: 'xs', lg: 'sm' }} opacity={0.8}>Selected: {selectedLabel}</Text>
            <Button size={{ base: 'xs', lg: 'sm' }} onClick={reset} variant="outline" borderColor="#2a3550" _hover={{ bg: '#131a2b' }} minH={{ base: '44px', lg: 'auto' }}>Reset</Button>

            <Box h="1px" bg="#1d2333" />
            <ToolPanel
              onTemplateSelect={handleTemplateSelect}
              onLayoutChange={handleLayoutChange}
              layout={layout}
            />

            <Box h="1px" bg="#1d2333" />
            <Text fontSize={{ base: 'md', lg: 'lg' }} fontWeight="bold">Requirements</Text>
            <VStack align="stretch" spacing={{ base: 0.5, lg: 1 }}>
              <Text fontSize={{ base: 'xs', lg: 'sm' }} color={getRequirementColor(hasTitle)}>Set a Title</Text>
              <Text fontSize={{ base: 'xs', lg: 'sm' }} color={getRequirementColor(hasStart)}>Needs a start tile</Text>
              <Text fontSize={{ base: 'xs', lg: 'sm' }} color={getRequirementColor(hasFinish)}>Needs a finish tile</Text>
              <Text fontSize={{ base: 'xs', lg: 'sm' }}>Cars per Race: {numStartTiles}</Text>
            </VStack>
          </VStack>
        </Box>
      </VStack>

      <Flex flex="1" direction="column" minH={{ base: '50vh', lg: 'auto' }}>
        <HStack p={{ base: 2, lg: 4 }} spacing={{ base: 2, lg: 4 }} borderBottom="1px solid #1d2333" bg="#0f1422" flexWrap={{ base: 'wrap', lg: 'nowrap' }} w="100%">
          <Text fontWeight="bold" fontSize={{ base: 'sm', lg: 'md' }} w={{ base: '100%', lg: 'auto' }}>Track Designer</Text>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Track Name"
            textAlign="center"
            maxW={{ base: '100%', lg: '280px' }}
            size="sm"
            bg="#0b0e17"
            borderColor={isAddTrackFocused && !hasTitle ? "#ff0000" : "#2a3550"}
            _focus={{ borderColor: !hasTitle ? "#ff0000" : "#274bff" }}
            _hover={{ borderColor: isAddTrackFocused && !hasTitle ? "#ff0000" : "#2a3550" }}
            transition="border-color 0.2s ease"
            minH={{ base: '44px', lg: 'auto' }}
            w={{ base: '100%', lg: 'auto' }}
          />
          <HStack spacing={{ base: 1, lg: 2 }} w={{ base: '100%', lg: 'auto' }}>
            <Text fontSize={{ base: 'xs', lg: 'sm' }}>W</Text>
            <Input size="sm" type="number" value={width} max={MAX} onChange={onWidthChange} w={{ base: '60px', lg: 'fit-content' }} minH={{ base: '44px', lg: 'auto' }} />
            <Text fontSize={{ base: 'xs', lg: 'sm' }}>H</Text>
            <Input size="sm" type="number" value={height} max={MAX} onChange={onHeightChange} w={{ base: '60px', lg: 'fit-content' }} minH={{ base: '44px', lg: 'auto' }} />
          </HStack>
          <Box
            onFocus={() => setIsAddTrackFocused(true)}
            onBlur={() => setIsAddTrackFocused(false)}
            onMouseEnter={() => setIsAddTrackFocused(true)}
            onMouseLeave={() => setIsAddTrackFocused(false)}
            w={{ base: '100%', lg: 'auto' }}
          >
            <ConfirmModal
              label="Add Track"
              action={addTrackTx.action}
              isDisabled={!name || name.length === 0}
              buttonProps={{
                colorScheme: "blue",
                bg: "#274bff",
                _hover: { bg: "#1f3bd9" },
                size: { base: 'sm', lg: 'md' },
                fontSize: { base: 'xs', lg: 'sm' },
                minH: { base: '44px', lg: 'auto' },
                w: { base: '100%', lg: 'auto' }
              }}
            />
          </Box>
        </HStack>

        <Flex flex="1" overflow="auto" p={{ base: 2, lg: 4 }} alignItems="flex-start" justifyContent={{ base: 'center', lg: 'flex-start' }}>
          <Box
            onMouseDown={() => setIsMouseDown(true)}
            onMouseUp={() => setIsMouseDown(false)}
            onMouseLeave={() => setIsMouseDown(false)}
            border="1px solid #1d2333"
            bg="#0b0e17"
            display="inline-block"
            maxW={{ base: '100%', lg: 'auto' }}
            maxH={{ base: '60vh', lg: 'auto' }}
            overflow="auto"
          >
            <Grid
              templateColumns={gridTemplate}
              gap="1px"
              bg="#1d2333"
            >
              {layout.map((row, y) => row.map((tile, x) => {
                const color = tile.blocks_movement ? '#0033ff'
                  : tile.is_finish ? '#00ff00'
                    : tile.is_start ? 'red'
                      : tile.skip_next_turn ? '#555555'
                        : tile.speed_modifier > 1 ? '#ffdd00'
                          : '#111111'
                return (
                  <GridItem
                    key={`${x}-${y}`}
                    w={`${cellSize}px`}
                    h={`${cellSize}px`}
                    bg={color}
                    onMouseDown={() => paintAt(x, y)}
                    onMouseEnter={() => { if (isMouseDown) paintAt(x, y) }}
                  />
                )
              }))}
            </Grid>
          </Box>
        </Flex>
      </Flex>
    </Flex>
  )
}

export default TrackCreator 