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

function getTracingSystemContent(language: SupportedLanguage): string {
  const languageDirective = language === 'en'
    ? 'Output your analysis in English.'
    : 'Output your analysis in Indonesian (Bahasa Indonesia).'

  return `
  You are an application architecture expert, well-versed in containerized microservice applications and familiar with k8s operations.
  I have an application call chain tracing result in JSON format. This result shows how an application request traverses various nodes, along with the monitoring data for each node.
  The data format is a JSON array where deepflow_span_id is the current span's id, deepflow_parent_span_id is the parent span's id, and the entire call chain is linked through these two fields. If a span's deepflow_parent_span_id is an empty string, it is the initial span.
  Focus on start_time_us, end_time_us, and selftime - all in microseconds. These represent the span's start time, end time, and self-consumed time. Generally, a parent node's start and end times encompass the child node's start and end times.
  Based on the input, evaluate the result concisely, identifying the most likely problematic resources and causes.
  We primarily care about service and resource related spans: service spans have the auto_service field, and resource spans have the auto_instance field. In the results, we only care about these spans, and we use the corresponding auto_service or auto_instance as their names.
  If there are other spans between two service or resource spans, those are intermediate access nodes.
  Pay special attention to the following:
  1. If a span has multiple child spans with identical call content, this is typically a loop call. Count the identical child spans and report it as an issue, including which node it is, which identical child span was called, and how many times.

  ---
  Output requirements (be concise):
  1. What issues exist in the entire call chain. Provide accurate time and data to illustrate problems. We only care about service or resource spans - use the corresponding auto_service or auto_instance as names when describing them.
  2. Which services or resources have outstanding issues. Provide accurate time and data to illustrate problems.
  3. In items 1 and 2, list all problematic areas you identify. Minimize omissions unless there are too many.
  4. Output a JSON array containing problematic services with simple text descriptions. Place this as pure JSON at the end of the output. Do not include any other markup or text describing that it is JSON.
  ====
  After outputting the results, restructure them as follows:
  I need to perform secondary processing on the JSON within the output. The entire text should read naturally and without any ambiguity if the JSON is removed. For example, do not include phrases like "Below is the JSON array output for the identified issues" or similar statements. Analyze the entire response, output the content, and append the JSON separately at the end.

  ${languageDirective}
`
}

interface Props {
  data: {
    tracing?: any[]
  }
}

export const AskGPT: React.FC<Props> = ({ data }) => {
  const { tracing } = data
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
        system_content: getTracingSystemContent(language),
        user_content: JSON.stringify(tracing)
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
