import React from "react";
import Line from "./components/Line";
import FilterBar from "./components/FilterBar";
import SectionIndicator from "./components/SectionIndicator";
import FindDialog from "./components/FindDialog";
import matches from "./utils/matches";
import "./App.css";

export default class App extends React.PureComponent {
  constructor(props) {
    super(props);

    let logLines = props.log.split("\n");
    let sectionInfo = [];

    logLines.forEach((line, index) => {
      if (line.startsWith(">>>>> ")) {
        sectionInfo.push([index + 1, line.substr(6)]);
      }
    });

    this.state = {
      zoom: 1,
      logLines,
      sectionInfo,
      linesVisible: logLines.map(ignored => true),
      sectionHint: "",
      searchDialogShown: false,
      search: "",
      searchAt: 0,
      searchOccurrences: []
    };

    window.onkeydown = (event) => {
      if (event.key === '=' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.setState({zoom: this.state.zoom / 0.9});
      } else if (event.key === '-' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.setState({zoom: this.state.zoom * 0.9});
      } else if (event.key === 'f' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.setState({searchDialogShown: true}, () => {
          document.getElementById("search-box").focus();
        });
      } else if (event.key === "Escape") {
        if (this.state.searchDialogShown) {
          this.setState({search: "", searchAt: 0, searchOccurrences: [], searchDialogShown: false});
        }
      }
    }
  }

  linesClick = (event) => {
    if (+event.target.getAttribute("data-index") < 0) {
      this.setState({sectionHint: ""});
    } else {
      let index = +event.target.getAttribute("data-index");
      let text = "";
      for (let section of this.state.sectionInfo) {
        if (section[0] === index + 1) {
          text = "";
          break;
        } else if (section[0] <= index) {
          text = section[1];
        }
      }
      this.setState({sectionHint: text});
    }
  };

  onFilterBarChange = (search) => {
    this.setState({
      linesVisible: this.state.logLines.map(line => (!search || !search.trim() || matches(line, search))),
      searchAt: 0,
      searchOccurrences: [],
    })
  };

  find = () => {
    this.setState({
      sectionHint: ""
    });
    if (!this.state.searchOccurrences[this.state.searchAt]) {
      return;
    }

    let lines = document.getElementsByClassName("lines")[0];
    for (let child of Array.from(lines.children)) {
      if (+child.getAttribute("data-index") === +this.state.searchOccurrences[this.state.searchAt][0]) {
        if (child.parentNode.parentNode.scrollTop > child.offsetTop) {
          child.parentNode.parentNode.scroll(0, child.offsetTop);
        }
        if (child.parentNode.parentNode.scrollTop < child.offsetTop - window.innerHeight + 100) {
          child.parentNode.parentNode.scroll(0, child.offsetTop - window.innerHeight + 100);
        }
        break;
      }
    }
  };

  normalizeAt(newAt) {
    if (!this.state.searchOccurrences.length) {
      return 0;
    }
    while (newAt >= this.state.searchOccurrences.length) {
      newAt -= this.state.searchOccurrences.length;
    }
    while (newAt < 0) {
      newAt += this.state.searchOccurrences.length;
    }
    return newAt;
  }

  findNext = () => {
    if (!this.state.searchOccurrences.length) {
      this.onFindDialogChange(this.state.search);
      setTimeout(this.findNext);
    }
    let newAt = this.normalizeAt(this.state.searchAt + 1);
    this.setState({searchAt: newAt}, this.find);
  };

  findPrev = () => {
    if (!this.state.searchOccurrences.length) {
      this.onFindDialogChange(this.state.search);
      setTimeout(this.findPrev);
    }
    let newAt = this.normalizeAt(this.state.searchAt - 1);
    this.setState({searchAt: newAt}, this.find);
  };

  onFindDialogChange = (keyword) => {
    if (!keyword || !keyword.trim()) {
      this.setState({search: "", searchOccurrences: []});
      return;
    }
    try {
      let re = new RegExp(keyword, "gi");
      let occurrences = [];

      this.state.logLines.forEach((line, index) => {
        if (!this.state.linesVisible[index]) {
          return;
        }

        let match;
        do {
          match = re.exec(line);
          if (match) {
            occurrences.push([index, match.index, match[0].length]);
          }
        } while (match);
      });

      let resumeIndex = 0;
      let lines = document.getElementsByClassName("lines")[0];
      for (let child of Array.from(lines.children)) {
        if (child.offsetTop - child.parentNode.parentNode.scrollTop <= 10) {
          resumeIndex = +child.getAttribute("data-index");
        }
      }

      let searchAt = 0;
      if (resumeIndex > 0) {
        occurrences.forEach((item, index) => {
          if (+item[0] < +resumeIndex) {
            searchAt = index;
          }
        });
      }

      this.setState({search: keyword, searchOccurrences: occurrences, searchAt: searchAt});

    } catch (e) {

      this.setState({searchOccurrences: [], searchAt: 0});

    }
  };

  render() {
    return <div className="wrapper">

      <div className="lines" onClick={this.linesClick} style={{zoom: this.state.zoom}}>
        {this.state.logLines
          .map((line, index) => {
            if (!this.state.linesVisible[index]) {
              return null;
            }
            if (this.state.searchDialogShown && this.state.searchOccurrences[this.state.searchAt] && +this.state.searchOccurrences[this.state.searchAt][0] === +index) {
              return <Line
                highlightRange={[+this.state.searchOccurrences[this.state.searchAt][1], +this.state.searchOccurrences[this.state.searchAt][2]]}
                key={index} line={line} index={index}/>;
            } else {
              return <Line key={index} line={line} index={index}/>;
            }
          }).filter(item => item)}
      </div>

      <FilterBar onChange={this.onFilterBarChange}/>

      {this.state.searchDialogShown &&
      <FindDialog value={this.state.search}
                  at={this.state.searchAt}
                  count={this.state.searchOccurrences.length}
                  onChange={this.onFindDialogChange}
                  findPrev={this.findPrev}
                  findNext={this.findNext}
      />}

      <SectionIndicator text={this.state.sectionHint}/>

    </div>
  }
}
