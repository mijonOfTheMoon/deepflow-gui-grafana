import _ from 'lodash'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Drawer, IconButton, InlineField, Select } from '@grafana/ui'
import { getAppEvents } from '@grafana/runtime'
import { marked } from 'marked'
import { AppEvents, SelectableValue } from '@grafana/data'
import aiIcon from '../img/ai.svg'
import copy from 'copy-text-to-clipboard'

const appEvents = getAppEvents()

import './AskGPT.css'
import { findLastVisibleTextNode, getDeepFlowDatasource } from 'utils/tools'

type SupportedLanguage = 'en' | 'id'

interface LanguageOption {
  label: string
  value: SupportedLanguage
}

const LANGUAGE_OPTIONS: LanguageOption[] = [
  { label: 'English', value: 'en' },
  { label: 'Indonesian', value: 'id' },
]

function getTopoSystemContent(language: SupportedLanguage): string {
  const languageDirective = language === 'en'
    ? 'Output your analysis in English.'
    : 'Output your analysis in Indonesian (Bahasa Indonesia).'

  return `
  Based on the provided network topology JSON, the links describe access relationships between nodes. The metricValue represents the main metric value for the access; there will be a matching value in the data whose corresponding key indicates what the metric is.
  Fields prefixed with client_ represent the client side, and fields prefixed with server_ represent the server side. Nodes with the same node_type and resource_id are the same node.
  Please analyze according to the following steps:
  1. Consolidate the links into appropriate nodes and construct the access relationships between them. Carefully verify that each relationship is consistent with the original data. You may describe frequently accessed nodes, for example: Node A is accessed by 10 other nodes. However, do not list more than 5 frequently accessed nodes.
  2. Based on the access relationships constructed in step 1, analyze whether certain nodes are access focal points or bottlenecks. Output all discovered focal points and bottlenecks, making sure to include all problematic nodes.
  3. For the nodes identified in step 2, retrieve their corresponding id, name, and node_type, and place them as pure JSON at the end of the output. Do not include any other markup or text describing that it is JSON.

  ---
  Note: You must analyze all the data. Do not repeat the step descriptions; just output the corresponding results.
  ====
  After outputting the results, restructure them as follows:
  I need to perform secondary processing on the JSON within the output. The entire text should read naturally and without any ambiguity if the JSON is removed. For example, do not include phrases like "Below is the JSON array output for the identified issues" or similar statements. Analyze the entire response, output the content, and append the JSON separately at the end.

  ${languageDirective}
`
}

interface Props {
  data: {
    links?: any[]
  }
}

export const AskGPT: React.FC<Props> = ({ data }) => {
  const { links } = data
  const [errorMsg, setErrorMsg] = useState('')
  const [visible, setVisible] = useState(false)
  const DEFAULT_STATE = {
    inRequest: false,
    answer: '',
    answerIsEnd: false
  }
  const [drawerData, setDrawerData] = useState<any>(DEFAULT_STATE)
  const onClose = () => {
    setVisible(false)
    setLanguage('en')
    streamerCache?.cleanup()
    streamerCache?.end()
  }

  let answerStr = ''
  let streamerCache: any = undefined
  const receiveFn = (data: { isEnd: Boolean; char: string; streamer: any }) => {
    // const { streamer } = data
    // if (!visible) {
    //   return
    // }
    const { isEnd, char, streamer } = data
    streamerCache = streamer
    if (isEnd) {
      setDrawerData({
        inRequest: false,
        answer: char,
        answerIsEnd: isEnd
      })
    } else {
      answerStr += char
      setDrawerData({
        inRequest: true,
        answer: answerStr,
        answerIsEnd: isEnd
      })
      // setTimeout(() => {
      //   console.log('@close')
      //   streamer.cleanup()
      //   streamer.end()
      // }, 2000)
    }
  }

  const answerAfterFormat = useMemo(() => {
    const answer = drawerData.answer
    const answerIsEnd = drawerData.answerIsEnd
    if (!answer) {
      return ''
    }
    let result = answer
    const jsonStartStr = '```json'
    const jsonEndStr = '```'
    const jsonStart = answer.includes(jsonStartStr)
    const jsonEnd = answer.match(/```json[\s\S]*?```/)
    if (jsonStart && jsonEnd) {
      result = result.replace(/```json[\s\S]*?```/, (e: any) => {
        const res = e.replace(jsonStartStr, '').replace(jsonEndStr, '').replace('...', '')
        let data: any
        try {
          // eslint-disable-next-line no-eval
          eval(`data = ${res}`)
          if (!Array.isArray(data)) {
            data = [data]
          }
        } catch (e) {}
        if (!data) {
          return e
        }

        return data
          .map((d: any, i: number) => {
            const { node_type, name: podName } = d
            if (node_type?.toLocaleLowerCase() === 'pod' && podName) {
              const prefix = window.location.href.split('/d')[0]
              const href = `${prefix}/d/Application_K8s_Pod/application-k8s-pod?orgId=1&var-pod=${podName}`
              return `<a style="margin: 10px 0; text-decoration: underline; color: #6e9fff; display: block;" href="${href}" target="_blank">进一步查看 ${d.name} (pod)</a>`
            } else {
              return `<pre style="margin: 10px 0;">${Object.keys(d)
                .map(e => {
                  return `${e} = ${d[e]}`
                })
                .join(', ')}</pre>`
            }
          })
          .join('')
      })
    } else if (jsonStart && !jsonEnd) {
      result = result.includes(jsonStartStr) ? result.split(jsonStartStr)[0] : ''
    }
    const htmlText = marked.parse(result) as string
    if (answerIsEnd) {
      return htmlText
    }
    const parser = new DOMParser()
    const doc = parser.parseFromString(htmlText, 'text/html')
    const target = findLastVisibleTextNode(doc) as any
    if (!target) {
      return htmlText
    }
    const newTextElement = document.createElement('b')
    newTextElement.setAttribute('class', 'blink')
    if (target.nodeType === Node.TEXT_NODE) {
      target.parentNode.appendChild(newTextElement)
    } else {
      target.appendChild(newTextElement)
    }
    return doc.body.innerHTML
  }, [drawerData.answer, drawerData.answerIsEnd])

  useEffect(() => {
    if (!answerWrapperRef.current) {
      return
    }
    const answerWrapper = answerWrapperRef.current as HTMLElement
    if (answerAfterFormat === '') {
      if (answerWrapperRef.current) {
        answerWrapper.scrollTop = 0
      }
    } else {
      if (answerWrapperRef.current) {
        const maxScrollTop = answerWrapper.scrollHeight - answerWrapper.clientHeight
        if (answerWrapper.scrollTop !== maxScrollTop) {
          answerWrapper.scrollTop = maxScrollTop
        }
      }
    }
  }, [answerAfterFormat])

  const onStartRequestClick = async () => {
    const deepFlow = await getDeepFlowDatasource()
    if (!deepFlow) {
      return
    }

    try {
      setDrawerData({
        ...drawerData,
        answer: '',
        inRequest: true
      })
      answerStr = ''
      streamerCache = undefined
      if (!checkedAiEngine) {
        throw new Error('Please select an AI engine')
      }
      const engine = JSON.parse(checkedAiEngine)
      const postData = {
        system_content: getTopoSystemContent(language),
        user_content: JSON.stringify(
          links?.map(e => {
            return _.omit(e, ['from', 'to', 'metrics', 'metricsGroup'])
          })
        )
      }
      // @ts-ignore
      await deepFlow.askGPTRequest(engine, postData, receiveFn)
    } catch (error: any) {
      setDrawerData({
        ...drawerData,
        inRequest: false,
        errorMsg: error.message
      })

      setErrorMsg(`REQUEST FAILED: ${error.message}`)

      setTimeout(() => {
        setErrorMsg('')
      }, 800)
    }
  }

  useEffect(() => {
    if (errorMsg) {
      appEvents.publish({
        type: AppEvents.alertError.name,
        payload: [errorMsg]
      })
    }
  }, [errorMsg])

  const answerWrapperRef = useRef(null)

  const requestBtnText = useMemo(() => {
    if (errorMsg) {
      return 'Error'
    }
    if (drawerData.inRequest) {
      if (drawerData.answer) {
        return 'Receiving...'
      }
      return 'Requesting...'
    }
    return 'Start Request'
  }, [errorMsg, drawerData.inRequest, drawerData.answer])

  const [language, setLanguage] = useState<SupportedLanguage>('en')
  const [aiEngines, setAiEngines] = useState<any[]>([])
  const [checkedAiEngine, setCheckedAiEngine] = useState<any>('')
  const getAiEngines = async () => {
    try {
      const deepFlow = await getDeepFlowDatasource()
      if (!deepFlow) {
        throw new Error('Please check if DeepFlow datasource is enabled')
      }
      setAiEngines([])
      // @ts-ignore
      const result = await deepFlow.getAIConfigs()
      const list = Object.keys(result)
        .map((k: string) => {
          const item = result[k]
          const engines = Array.isArray(item.engine_name) ? item.engine_name : [item.engine_name]
          return (
            engines?.map((engine_name: string) => {
              return {
                label: `${engine_name}${item.enable === '0' ? ' (disabled)' : ''}`,
                value: JSON.stringify({
                  platform: k,
                  engine_name
                }),
                disabled: item.enable === '0'
              }
            }) ?? []
          )
        })
        .flat()
      setAiEngines(list)
      setCheckedAiEngine(list.filter(e => !e.disabled)?.[0]?.value || '')
    } catch (error: any) {
      setErrorMsg(`GET ENGINES FAILED: ${error.message}`)
      setDrawerData({
        inRequest: false,
        answer: `<a style="margin: 10px 0; text-decoration: underline; color: #6e9fff; display: block;" href="https://deepflow.io/docs/zh/best-practice/production-deployment/#%E4%BD%BF%E7%94%A8ai%E6%A8%A1%E5%9E%8B" target="_blank">Engine帮助文档</a>`,
        answerIsEnd: true
      })
      setTimeout(() => {
        setErrorMsg('')
      }, 800)
    }
  }
  useEffect(() => {
    if (visible) {
      getAiEngines()
    }
  }, [visible])

  const [copyBtnIconName, setCopyBtnIconName] = useState<'copy' | 'check'>('copy')
  const copyAnswer = () => {
    if (!drawerData.answer) {
      return
    }
    copy(drawerData.answer)
    setCopyBtnIconName('check')
    setTimeout(() => {
      setCopyBtnIconName('copy')
    }, 1800)
  }

  return (
    <div>
      <Button
        size="sm"
        style={{
          position: 'fixed',
          top: '5px',
          right: '5px',
          zIndex: 9999
        }}
        tooltip="Ask GPT, support by DeepFlow"
        onClick={() => {
          setVisible(true)
        }}
      >
        Ask GPT
      </Button>
      {visible ? (
        <Drawer title="Ask GPT" onClose={onClose}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              position: 'relative'
            }}
          >
            <div>
              <InlineField label="Engine:">
                <Select
                  width="auto"
                  options={aiEngines}
                  value={checkedAiEngine}
                  onChange={(v: any) => {
                    setCheckedAiEngine(v.value)
                  }}
                  placeholder="Select an AI engine"
                  noOptionsMessage="No Engines"
                  isOptionDisabled={(option: SelectableValue<any>) => option.disabled}
                />
              </InlineField>
              <InlineField label="Language:">
                <Select
                  width="auto"
                  options={LANGUAGE_OPTIONS}
                  value={language}
                  onChange={(v: any) => {
                    setLanguage(v.value)
                  }}
                />
              </InlineField>
            </div>
            <Button
              style={{
                display: 'flex',
                justifyContent: 'center',
                pointerEvents: drawerData.inRequest ? 'none' : 'auto'
              }}
              onClick={onStartRequestClick}
              icon={drawerData.inRequest ? 'fa fa-spinner' : 'info'}
              variant={drawerData.inRequest ? 'secondary' : 'primary'}
            >
              {requestBtnText}
            </Button>
            <img
              src={aiIcon}
              style={{
                width: '16px',
                height: '16px',
                position: 'absolute',
                right: '115px',
                top: '7px',
                opacity: drawerData.inRequest ? 0 : 1
              }}
            />
          </div>
          <section
            ref={answerWrapperRef}
            style={{
              height: 'calc(100% - 42px)',
              marginTop: '10px',
              overflow: 'auto'
            }}
          >
            {checkedAiEngine && drawerData.answer !== '' && !drawerData.inRequest ? (
              <IconButton
                onClick={copyAnswer}
                aria-label="Copy"
                name={copyBtnIconName}
                style={{
                  width: '16px',
                  height: '16px',
                  position: 'sticky',
                  left: '100%',
                  top: '4px'
                }}
              />
            ) : null}
            <div className="answer-content" dangerouslySetInnerHTML={{ __html: answerAfterFormat }} />
          </section>
        </Drawer>
      ) : null}
    </div>
  )
}
